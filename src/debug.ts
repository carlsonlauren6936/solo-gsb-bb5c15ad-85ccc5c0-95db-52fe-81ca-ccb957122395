import type { Rule, Simulation, Step } from './types';
import { MAX_STEPS, findMatch, resolveTarget, substitute } from './engine';

/**
 * 断点调试会话：与 {@link simulate} 共用同一套匹配语义与引擎常量
 * （findMatch / resolveTarget / substitute / MAX_STEPS），
 * 只是把一次完整执行拆成「启动 / 单步 / 继续」，可在动作执行前暂停。
 *
 * 关键不变量：**暂停不清空任何执行状态**——循环检测的已见状态键集合与
 * 已执行步数都保留在会话里（pending 所在步的状态键也已计入），
 * 继续 / 单步时原样沿用，绝不因暂停而重置。
 */

/** 暂停时尚未执行动作的命中信息 */
export interface PendingHit {
  /** 即将执行的是第几步（从 1 开始，与轨迹中的步骤号一致） */
  n: number;
  method: string;
  /** 该步的循环检测状态键：方法 + 序列化 URL（此时已计入 seen） */
  stateKey: string;
  /** 命中发生时的 URL（动作执行前） */
  url: string;
  ruleIndex: number;
  /** 命中时刻的规则快照，之后规则被编辑也不影响本会话展示 */
  rule: Rule;
  params: Record<string, string>;
}

export interface DebugSession {
  /** paused：在某条命中规则的动作执行前暂停；finished：已终止（成功 / 失败） */
  phase: 'paused' | 'finished';
  method: string;
  /** 会话开始时的输入 URL，仅用于展示 */
  inputUrl: string;
  /** 已执行动作产生的步骤（当前暂停步不在其中） */
  steps: Step[];
  /** phase=paused 时，下一条即将执行的实际命中规则 */
  pending: PendingHit | null;
  /** phase=finished 时的完整模拟结果（终止原因与可观察结果） */
  result: Simulation | null;
}

/** 调试器内部运行态：循环检测状态与步数都在这里延续 */
interface RunnerState {
  method: string;
  inputUrl: string;
  url: URL;
  /** 此前每一步（含当前暂停步）的状态键，用于循环检测 */
  seen: Set<string>;
  steps: Step[];
  /** 下一个待评估的步号 */
  n: number;
}

/** 暂停策略：breakpoint=仅在带断点规则前停；hit=下一条命中规则前必停（单步） */
type PauseMode = 'breakpoint' | 'hit';

function failResult(
  status: Simulation['status'],
  steps: Step[],
  reason: string,
): Simulation {
  return { status, ok: false, steps, reason };
}

/**
 * 执行一条命中规则的动作（逻辑与 simulate 内联部分逐字对应，保证语义一致）：
 * - stop / redirect / 目标非法：写入步骤并返回终止结果；
 * - rewrite：写入步骤、推进当前 URL 与步号，返回 null 表示可继续匹配。
 */
function executeHit(
  state: RunnerState,
  n: number,
  stateKey: string,
  index: number,
  rule: Rule,
  params: Record<string, string>,
): Simulation | null {
  const step: Step = {
    n,
    method: state.method,
    stateKey,
    urlBefore: state.url.toString(),
    ruleIndex: index,
    rule: structuredClone(rule),
    params,
  };

  if (rule.action.type === 'stop') {
    state.steps.push(step);
    return {
      status: 'stopped',
      ok: true,
      steps: state.steps,
      reason: `被第 ${index + 1} 条规则「${rule.name}」停止，请求到此终止`,
    };
  }

  const target = substitute(rule.action.target, params);
  let next: URL;
  try {
    next = resolveTarget(target, state.url);
  } catch {
    state.steps.push(step);
    return failResult(
      'invalid-target',
      state.steps,
      `规则「${rule.name}」的目标「${target}」无法解析为有效 URL`,
    );
  }

  if (rule.action.type === 'redirect') {
    step.location = next.toString();
    step.status = rule.action.status;
    state.steps.push(step);
    return {
      status: 'redirect',
      ok: true,
      steps: state.steps,
      reason: `第 ${index + 1} 条规则「${rule.name}」返回 ${rule.action.status} 重定向`,
      redirectLocation: step.location,
      redirectStatus: rule.action.status,
    };
  }

  // rewrite：应用后从第一条规则重新匹配
  step.urlAfter = next.toString();
  state.steps.push(step);
  state.url = next;
  state.n = n + 1;
  return null;
}

/**
 * 从当前运行态推进到下一个暂停点或终止。
 * 每轮先算状态键并做循环检测，再找首条命中规则——顺序与 simulate 完全一致。
 */
function advance(
  state: RunnerState,
  rules: readonly Rule[],
  breakpoints: ReadonlySet<string>,
  mode: PauseMode,
): { pending: PendingHit | null; result: Simulation | null } {
  for (; state.n <= MAX_STEPS; ) {
    const n = state.n;
    const stateKey = `${state.method} ${state.url.toString()}`;
    if (state.seen.has(stateKey)) {
      return {
        pending: null,
        result: failResult(
          'loop',
          state.steps,
          `检测到循环：状态「${stateKey}」在第 ${n} 步再次出现`,
        ),
      };
    }
    state.seen.add(stateKey);

    const match = findMatch(rules as Rule[], state.method, state.url);
    if (!match) {
      return {
        pending: null,
        result: {
          status: 'final',
          ok: true,
          steps: state.steps,
          reason:
            state.steps.length === 0
              ? '没有任何规则命中，按原始请求放行'
              : '没有更多规则命中，以当前 URL 作为最终结果',
          finalUrl: state.url.toString(),
        },
      };
    }

    const { rule, index, params } = match;
    if (mode === 'hit' || breakpoints.has(rule.id)) {
      // 注意：stateKey 此刻已加入 seen，暂停也不会撤回，循环检测状态因此连续
      return {
        pending: {
          n,
          method: state.method,
          stateKey,
          url: state.url.toString(),
          ruleIndex: index,
          rule: structuredClone(rule),
          params,
        },
        result: null,
      };
    }

    const terminated = executeHit(state, n, stateKey, index, rule, params);
    if (terminated) return { pending: null, result: terminated };
  }

  return {
    pending: null,
    result: failResult(
      'max-steps',
      state.steps,
      `已执行 ${MAX_STEPS} 步仍未终止，判定为潜在循环，不予返回成功结果`,
    ),
  };
}

function toSession(
  state: RunnerState,
  pending: PendingHit | null,
  result: Simulation | null,
): DebugSession {
  return {
    phase: pending ? 'paused' : 'finished',
    method: state.method,
    inputUrl: state.inputUrl,
    steps: state.steps,
    pending,
    result,
  };
}

function finishedSession(
  method: string,
  inputUrl: string,
  result: Simulation,
): DebugSession {
  return {
    phase: 'finished',
    method: method.toUpperCase(),
    inputUrl,
    steps: result.steps,
    pending: null,
    result,
  };
}

/**
 * 启动调试：暂停在**首条带断点的命中规则**的动作执行前；
 * 没有任何断点会命中（或没有断点）时直接运行到终止，结果与 simulate 一致。
 */
export function startDebug(
  rules: readonly Rule[],
  method: string,
  inputUrl: string,
  breakpoints: ReadonlySet<string>,
): DebugSession {
  const m = method.toUpperCase();
  let url: URL;
  try {
    url = new URL(inputUrl);
  } catch {
    return finishedSession(
      m,
      inputUrl,
      failResult('invalid-url', [], `输入的 URL 无法解析：${inputUrl}`),
    );
  }

  const state: RunnerState = {
    method: m,
    inputUrl,
    url,
    seen: new Set<string>(),
    steps: [],
    n: 1,
  };
  const { pending, result } = advance(state, rules, breakpoints, 'breakpoint');
  return toSession(state, pending, result);
}

/** 从暂停会话还原内部运行态：已见状态键（含暂停步）、步数、当前 URL 全部沿用 */
function restore(session: DebugSession): RunnerState {
  const p = session.pending as PendingHit;
  const seen = new Set(session.steps.map((s) => s.stateKey));
  // 暂停步在暂停前已通过循环检测并把状态键计入 seen，必须补回
  seen.add(p.stateKey);
  return {
    method: session.method,
    inputUrl: session.inputUrl,
    url: new URL(p.url),
    seen,
    steps: session.steps.map((s) => structuredClone(s)),
    n: p.n,
  };
}

/**
 * 单步：执行当前暂停处的动作，然后暂停在**下一条实际命中规则**前
 * （无论它是否带断点）；动作终止、不再命中、循环或超限时结束会话。
 */
export function stepDebug(
  session: DebugSession,
  rules: readonly Rule[],
): DebugSession {
  if (session.phase === 'finished' || session.pending === null) return session;

  const state = restore(session);
  const p = session.pending;
  const terminated = executeHit(
    state,
    p.n,
    p.stateKey,
    p.ruleIndex,
    p.rule,
    p.params,
  );
  if (terminated) return toSession(state, null, terminated);

  // 空断点集 + hit 模式：下一条命中规则前必停
  const { pending, result } = advance(state, rules, new Set<string>(), 'hit');
  return toSession(state, pending, result);
}

/**
 * 继续：先执行当前暂停处的动作，再运行到**下一个断点**或终止。
 * 断点集合取调用时的最新值——暂停期间切换断点无需重开会话。
 */
export function continueDebug(
  session: DebugSession,
  rules: readonly Rule[],
  breakpoints: ReadonlySet<string>,
): DebugSession {
  if (session.phase === 'finished' || session.pending === null) return session;

  const state = restore(session);
  const p = session.pending;
  const terminated = executeHit(
    state,
    p.n,
    p.stateKey,
    p.ruleIndex,
    p.rule,
    p.params,
  );
  if (terminated) return toSession(state, null, terminated);

  const { pending, result } = advance(state, rules, breakpoints, 'breakpoint');
  return toSession(state, pending, result);
}
