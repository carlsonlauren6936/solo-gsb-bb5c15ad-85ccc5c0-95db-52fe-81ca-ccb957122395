import { describe, expect, it } from 'vitest';
import { continueDebug, startDebug, stepDebug } from './debug';
import { MAX_STEPS, simulate } from './engine';
import type { Rule } from './types';

function rule(partial: Partial<Rule> & { id: string }): Rule {
  return {
    name: partial.id,
    enabled: true,
    method: 'ANY',
    host: 'example.com',
    pathTemplate: '/',
    query: [],
    action: { type: 'rewrite', target: '/', status: 302 },
    ...partial,
  };
}

/** 链式重写规则：r1: /a → /b，r2: /b → /c，之后无命中 */
function chain(): Rule[] {
  return [
    rule({ id: 'r1', pathTemplate: '/a', action: { type: 'rewrite', target: '/b', status: 302 } }),
    rule({ id: 'r2', pathTemplate: '/b', action: { type: 'rewrite', target: '/c', status: 302 } }),
  ];
}

const ORIGIN = 'http://example.com';

describe('startDebug', () => {
  it('无断点时直接运行到终止，结果与 simulate 完全一致', () => {
    const rules = chain();
    const sim = simulate(rules, 'GET', `${ORIGIN}/a`);
    const session = startDebug(rules, 'GET', `${ORIGIN}/a`, new Set());
    expect(session.phase).toBe('finished');
    expect(session.result).toEqual(sim);
    expect(session.steps).toEqual(sim.steps);
  });

  it('暂停在首条带断点的命中规则前，展示方法 / URL / 规则 / 路径参数', () => {
    const rules = chain();
    const session = startDebug(rules, 'GET', `${ORIGIN}/a`, new Set(['r2']));
    expect(session.phase).toBe('paused');
    expect(session.pending).not.toBeNull();
    expect(session.steps).toHaveLength(1); // r1 的动作已执行
    expect(session.steps[0].rule.id).toBe('r1');
    const p = session.pending!;
    expect(p.n).toBe(2);
    expect(p.method).toBe('GET');
    expect(p.url).toBe(`${ORIGIN}/b`);
    expect(p.rule.id).toBe('r2');
    expect(p.ruleIndex).toBe(1);
    expect(p.params).toEqual({});
    expect(p.stateKey).toBe(`GET ${ORIGIN}/b`);
  });

  it('断点打在首条命中规则上：尚未执行任何动作即暂停', () => {
    const rules = chain();
    const session = startDebug(rules, 'GET', `${ORIGIN}/a`, new Set(['r1']));
    expect(session.phase).toBe('paused');
    expect(session.steps).toHaveLength(0);
    expect(session.pending!.n).toBe(1);
    expect(session.pending!.url).toBe(`${ORIGIN}/a`);
    expect(session.pending!.params).toEqual({});
  });

  it('暂停信息包含捕获的路径参数', () => {
    const rules = [
      rule({
        id: 'r1',
        pathTemplate: '/users/:id',
        action: { type: 'rewrite', target: '/u/:id', status: 302 },
      }),
    ];
    const session = startDebug(rules, 'GET', `${ORIGIN}/users/42`, new Set(['r1']));
    expect(session.pending!.params).toEqual({ id: '42' });
  });

  it('断点规则未启用 / 不会命中时不停，直接终止', () => {
    const rules = [
      rule({ id: 'off', enabled: false, pathTemplate: '/a' }),
      rule({ id: 'nomatch', host: 'other.com' }),
    ];
    const session = startDebug(
      rules,
      'GET',
      `${ORIGIN}/a`,
      new Set(['off', 'nomatch']),
    );
    expect(session.phase).toBe('finished');
    expect(session.result!.status).toBe('final');
  });

  it('非法 URL 直接给出 invalid-url 结束会话', () => {
    const session = startDebug(chain(), 'GET', 'not a url', new Set(['r1']));
    expect(session.phase).toBe('finished');
    expect(session.result!.status).toBe('invalid-url');
    expect(session.pending).toBeNull();
  });

  it('redirect / stop 规则上的断点也会在动作前暂停', () => {
    const rules = [
      rule({ id: 'rd', pathTemplate: '/go', action: { type: 'redirect', target: 'https://x.com/', status: 301 } }),
    ];
    const s1 = startDebug(rules, 'GET', `${ORIGIN}/go`, new Set(['rd']));
    expect(s1.phase).toBe('paused');
    expect(s1.pending!.rule.action.type).toBe('redirect');
    expect(s1.steps).toHaveLength(0);
  });
});

describe('stepDebug 单步', () => {
  it('执行当前动作后暂停在下一条实际命中规则前（即使它没有断点）', () => {
    const rules = chain();
    let session = startDebug(rules, 'GET', `${ORIGIN}/a`, new Set(['r1']));
    expect(session.pending!.rule.id).toBe('r1');

    session = stepDebug(session, rules);
    expect(session.phase).toBe('paused');
    expect(session.steps).toHaveLength(1);
    expect(session.steps[0].urlAfter).toBe(`${ORIGIN}/b`);
    expect(session.pending!.rule.id).toBe('r2'); // r2 无断点也停
    expect(session.pending!.n).toBe(2);

    session = stepDebug(session, rules);
    expect(session.phase).toBe('finished');
    expect(session.steps).toHaveLength(2);
    expect(session.result!.status).toBe('final');
    expect(session.result!.finalUrl).toBe(`${ORIGIN}/c`);
  });

  it('动作是 redirect / stop 时单步后直接结束', () => {
    const rules = [
      rule({ id: 'rd', pathTemplate: '/go', action: { type: 'redirect', target: 'https://x.com/', status: 307 } }),
    ];
    let session = startDebug(rules, 'GET', `${ORIGIN}/go`, new Set(['rd']));
    session = stepDebug(session, rules);
    expect(session.phase).toBe('finished');
    expect(session.result!.status).toBe('redirect');
    expect(session.result!.redirectStatus).toBe(307);
    expect(session.result!.redirectLocation).toBe('https://x.com/');
  });

  it('非法重写目标在单步执行时以 invalid-target 结束', () => {
    const rules = [
      rule({ id: 'bad', pathTemplate: '/a', action: { type: 'rewrite', target: 'http://[', status: 302 } }),
    ];
    let session = startDebug(rules, 'GET', `${ORIGIN}/a`, new Set(['bad']));
    session = stepDebug(session, rules);
    expect(session.result!.status).toBe('invalid-target');
  });

  it('对已结束的会话单步是空操作', () => {
    const session = startDebug(chain(), 'GET', `${ORIGIN}/a`, new Set());
    const again = stepDebug(session, chain());
    expect(again).toBe(session);
  });
});

describe('continueDebug 继续', () => {
  it('执行当前动作后运行到下一个断点', () => {
    const rules = chain();
    // 断在 r1 启动；继续后应执行 r1 并断在 r2
    let session = startDebug(rules, 'GET', `${ORIGIN}/a`, new Set(['r1', 'r2']));
    expect(session.pending!.rule.id).toBe('r1');
    session = continueDebug(session, rules, new Set(['r1', 'r2']));
    expect(session.phase).toBe('paused');
    expect(session.steps).toHaveLength(1);
    expect(session.pending!.rule.id).toBe('r2');
    // 再次继续：执行 r2，之后无命中，结束
    session = continueDebug(session, rules, new Set(['r1', 'r2']));
    expect(session.phase).toBe('finished');
    expect(session.result!.status).toBe('final');
    expect(session.result!.finalUrl).toBe(`${ORIGIN}/c`);
  });

  it('后续没有断点时一路运行到终止', () => {
    const rules = chain();
    let session = startDebug(rules, 'GET', `${ORIGIN}/a`, new Set(['r1']));
    session = continueDebug(session, rules, new Set(['r1']));
    expect(session.phase).toBe('finished');
    expect(session.steps).toHaveLength(2);
    expect(session.result).toEqual(simulate(rules, 'GET', `${ORIGIN}/a`));
  });

  it('暂停期间增删断点立即生效：移除断点后继续不再停', () => {
    const rules = chain();
    let session = startDebug(rules, 'GET', `${ORIGIN}/a`, new Set(['r1', 'r2']));
    expect(session.pending!.rule.id).toBe('r1');
    // 移除 r2 断点后继续，应直接跑到终止
    session = continueDebug(session, rules, new Set(['r1']));
    expect(session.phase).toBe('finished');
    expect(session.steps).toHaveLength(2);
  });

  it('暂停期间新增断点：继续时停在新断点', () => {
    const rules = chain();
    let session = startDebug(rules, 'GET', `${ORIGIN}/a`, new Set());
    expect(session.phase).toBe('finished'); // 无断点直接跑完
    // 改为只在 r1 处启动
    session = startDebug(rules, 'GET', `${ORIGIN}/a`, new Set(['r1']));
    session = continueDebug(session, rules, new Set(['r1', 'r2']));
    expect(session.phase).toBe('paused');
    expect(session.pending!.rule.id).toBe('r2');
  });

  it('对已结束的会话继续是空操作', () => {
    const session = startDebug(chain(), 'GET', `${ORIGIN}/a`, new Set());
    expect(continueDebug(session, chain(), new Set(['r1']))).toBe(session);
  });
});

describe('暂停不重置循环检测与 20 步上限', () => {
  it('跨暂停仍能检测到循环（暂停步的状态键已计入）', () => {
    const rules = [
      rule({ id: 'a', pathTemplate: '/a', action: { type: 'rewrite', target: '/b', status: 302 } }),
      rule({ id: 'b', pathTemplate: '/b', action: { type: 'rewrite', target: '/a', status: 302 } }),
    ];
    // 启动停在 /a，单步到 /b 前，再单步执行 /b→/a：下一步应在 /a 处再次命中前
    // 因状态重复判循环，而不是把 /a 当成新状态再暂停一次。
    let session = startDebug(rules, 'GET', `${ORIGIN}/a`, new Set(['a']));
    expect(session.pending!.rule.id).toBe('a');
    session = stepDebug(session, rules); // 执行 a→/b，暂停在 b 前
    expect(session.pending!.rule.id).toBe('b');
    session = stepDebug(session, rules); // 执行 b→/a，下一步循环
    expect(session.phase).toBe('finished');
    expect(session.result!.status).toBe('loop');
    expect(session.result).toEqual(simulate(rules, 'GET', `${ORIGIN}/a`));
  });

  it('在每条规则上断点单步，循环结论与 simulate 一致', () => {
    const rules = [
      rule({ id: 'a', pathTemplate: '/a', action: { type: 'rewrite', target: '/b', status: 302 } }),
      rule({ id: 'b', pathTemplate: '/b', action: { type: 'rewrite', target: '/a', status: 302 } }),
    ];
    let session = startDebug(rules, 'GET', `${ORIGIN}/a`, new Set(['a', 'b']));
    let guard = 0;
    while (session.phase === 'paused' && guard < 50) {
      session = continueDebug(session, rules, new Set(['a', 'b']));
      guard++;
    }
    expect(session.result!.status).toBe('loop');
    expect(session.result!.steps).toEqual(simulate(rules, 'GET', `${ORIGIN}/a`).steps);
  });

  it(`暂停不计额外步数：超过 ${MAX_STEPS} 步仍判 max-steps`, () => {
    // /p0 → /p1 → ... /pN 链：每步一个新路径，用一张重写表驱动超过 20 步
    const rules: Rule[] = [];
    for (let i = 0; i <= MAX_STEPS; i++) {
      rules.push(
        rule({
          id: `p${i}`,
          pathTemplate: `/p${i}`,
          action: {
            type: 'rewrite',
            target: `/p${i + 1}`,
            status: 302,
          },
        }),
      );
    }
    const bp = new Set(rules.map((r) => r.id));
    let session = startDebug(rules, 'GET', `${ORIGIN}/p0`, bp);
    let executed = 0;
    let guard = 0;
    while (session.phase === 'paused' && guard < 100) {
      // 交替使用单步与继续；每次只执行当前暂停动作
      session =
        executed % 2 === 0
          ? stepDebug(session, rules)
          : continueDebug(session, rules, bp);
      executed++;
      guard++;
    }
    expect(session.phase).toBe('finished');
    expect(session.result!.status).toBe('max-steps');
    expect(session.steps).toHaveLength(MAX_STEPS);
    expect(session.result).toEqual(simulate(rules, 'GET', `${ORIGIN}/p0`));
  });
});

describe('暂停会话的规则快照独立性', () => {
  it('暂停步展示的是命中时刻的规则快照', () => {
    const rules = chain();
    const session = startDebug(rules, 'GET', `${ORIGIN}/a`, new Set(['r2']));
    const snapshot = session.pending!.rule;
    expect(snapshot.name).toBe('r2');
    // 外部修改规则表不影响会话内快照
    rules[1] = { ...rules[1], name: '被改名了' };
    expect(session.pending!.rule.name).toBe('r2');
  });
});
