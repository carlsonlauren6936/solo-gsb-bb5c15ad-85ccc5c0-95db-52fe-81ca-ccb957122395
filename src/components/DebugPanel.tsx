import type { DebugSession, PendingHit } from '../debug';
import { formatQueryConditions } from '../types';
import { StepCard, ResultBanner } from './TraceView';

interface Props {
  session: DebugSession;
  onStep: () => void;
  onContinue: () => void;
  onStop: () => void;
}

const ACTION_LABEL: Record<PendingHit['rule']['action']['type'], string> = {
  rewrite: '重写',
  redirect: '重定向',
  stop: '停止',
};

function hostOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return '?';
  }
}

function pathOf(u: string): string {
  try {
    return new URL(u).pathname;
  } catch {
    return '?';
  }
}

function searchOf(u: string): string {
  try {
    return new URL(u).search;
  } catch {
    return '';
  }
}

/** 暂停处的待执行命中卡：动作执行前展示当前方法、URL、命中规则与路径参数 */
function PendingCard({ hit }: { hit: PendingHit }) {
  const { rule } = hit;
  const params = Object.entries(hit.params);
  return (
    <div className="step step-pending">
      <header>
        <span className="step-n">即将执行 · 第 {hit.n} 步</span>
        命中规则 #{hit.ruleIndex + 1}「{rule.name}」
        <span className={`tag action-${rule.action.type}`}>
          {ACTION_LABEL[rule.action.type]}
        </span>
        <span className="tag tag-breakpoint-hit">断点暂停</span>
      </header>
      <ul className="conds">
        <li>
          方法 <code>{hit.method}</code> ✓ 匹配{' '}
          <code>{rule.method === 'ANY' ? 'ANY（任意方法）' : rule.method}</code>
        </li>
        <li>
          主机 <code>{hostOf(hit.url)}</code> ✓ 匹配 <code>{rule.host}</code>
        </li>
        <li>
          路径 <code>{pathOf(hit.url)}</code> ✓ 匹配模板{' '}
          <code>{rule.pathTemplate.trim() === '' ? '（任意路径）' : rule.pathTemplate}</code>
        </li>
        {(rule.query ?? []).length > 0 && (
          <li>
            查询 <code>{searchOf(hit.url) || '（无查询串）'}</code> ✓ 满足{' '}
            <code>{formatQueryConditions(rule.query ?? [])}</code>
          </li>
        )}
      </ul>
      {params.length > 0 && (
        <div className="params">
          已捕获路径参数：
          {params.map(([k, v]) => (
            <span key={k} className="chip">
              :{k} = {v}
            </span>
          ))}
        </div>
      )}
      <div className="url-line">
        <span className="url-from">{hit.url}</span>
        <span className="arrow">动作尚未执行</span>
      </div>
      <div className="state-key">状态键：{hit.stateKey}</div>
    </div>
  );
}

export function DebugPanel({ session, onStep, onContinue, onStop }: Props) {
  const { pending, result, steps } = session;
  return (
    <section className="panel debug-panel">
      <div className="panel-title">
        <h2>断点调试{pending ? '（已暂停）' : '（已结束）'}</h2>
        <div className="toolbar">
          <button
            onClick={onStep}
            disabled={pending === null}
            title="执行当前动作，暂停在下一条实际命中规则前"
          >
            ⤼ 单步
          </button>
          <button
            className="primary"
            onClick={onContinue}
            disabled={pending === null}
            title="运行到下一个断点或终止"
          >
            ▶ 继续
          </button>
          <button onClick={onStop} title="结束本次调试会话">
            结束调试
          </button>
        </div>
      </div>

      <p className="debug-hint">
        暂停不会重置循环检测状态与 20 步上限；「单步」执行当前动作后停在下一条命中规则前，
        「继续」运行到下一个断点或终止。
      </p>

      {steps.map((s) => (
        <StepCard key={s.n} step={s} />
      ))}
      {pending && <PendingCard hit={pending} />}
      {result && <ResultBanner sim={result} />}
    </section>
  );
}
