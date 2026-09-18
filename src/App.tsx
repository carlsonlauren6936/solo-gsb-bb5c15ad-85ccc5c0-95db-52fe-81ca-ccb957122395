import { useCallback, useEffect, useRef, useState } from 'react';
import type { Rule, Simulation } from './types';
import { simulate } from './engine';
import {
  continueDebug,
  startDebug,
  stepDebug,
  type DebugSession,
} from './debug';
import { validateRules } from './validate';
import { SAMPLE_RULES, PRESETS } from './samples';
import { useRuleHistory } from './useRuleHistory';
import { RulesPanel } from './components/RulesPanel';
import { Simulator } from './components/Simulator';
import { TraceView } from './components/TraceView';
import { DebugPanel } from './components/DebugPanel';
import { RegressionPanel } from './components/RegressionPanel';
import { ShareCreateDialog } from './components/ShareCreateDialog';
import { ShareUnlock } from './components/ShareUnlock';
import {
  cleanLocationUrl,
  parseShareHash,
  type SharePayload,
} from './share';

const STORAGE_KEY = 'url-route-debugger.rules.v1';

function loadRules(): Rule[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return validateRules(JSON.parse(raw));
  } catch {
    // 本地缓存损坏时回退到示例规则
  }
  return structuredClone(SAMPLE_RULES);
}

function readPendingShare(): string | null {
  try {
    return parseShareHash(window.location.hash);
  } catch {
    return null;
  }
}

/** 移除地址栏中的分享 hash（用 replaceState，不新增历史记录） */
function removeShareHash() {
  if (window.location.hash !== '') {
    window.history.replaceState(null, '', cleanLocationUrl());
  }
}

/** 事件目标是否是可编辑控件：此时保留浏览器原生编辑行为，不拦截快捷键 */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el === null) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable
  );
}

export default function App() {
  // 打开分享链接时，整个调试台让位给口令解锁页；任何解密/校验失败都保持当前状态不变
  const [pendingShare, setPendingShare] = useState<string | null>(readPendingShare);
  const [sharing, setSharing] = useState(false);

  const hist = useRuleHistory(loadRules);
  const { rules } = hist;
  const [method, setMethod] = useState(PRESETS[0].method);
  const [url, setUrl] = useState(PRESETS[0].url);
  const [sim, setSim] = useState<Simulation | null>(null);

  // 断点 id 集合与会话都只活在当前页面会话（内存），不做持久化
  const [breakpoints, setBreakpoints] = useState<Set<string>>(() => new Set());
  const [debug, setDebug] = useState<DebugSession | null>(null);
  // 暂停会话因规则 / 请求变化作废后的提示，重新开始调试时清除
  const [staleDebug, setStaleDebug] = useState<string | null>(null);

  // 在异步回调 / effect 中读取最新调试会话，避免闭包拿到旧值
  const debugRef = useRef<DebugSession | null>(null);
  debugRef.current = debug;

  /**
   * 规则或请求变化时，**暂停中**的调试会话立即作废：
   * 会话里的步骤 / 规则快照对应的是旧规则与旧请求，继续执行没有意义。
   * 已结束的会话只是一份结果展示，无需作废。
   */
  const invalidatePaused = useCallback((message: string) => {
    if (debugRef.current?.phase !== 'paused') return;
    setDebug(null);
    setStaleDebug(message);
  }, []);

  // 规则表任何变化（增删、排序、字段、启停、撤销 / 重做、导入）都即时作废旧暂停。
  // RuleHistory 的每次提交都会产出新数组，首屏挂载时引用相同，不误报。
  const prevRulesRef = useRef<Rule[]>(rules);
  useEffect(() => {
    if (prevRulesRef.current === rules) return;
    prevRulesRef.current = rules;
    invalidatePaused('规则已变化，暂停的调试会话已作废，请重新开始调试。');
    // 顺带清掉已被删除规则遗留的断点，避免计数包含幽灵 id
    setBreakpoints((prev) => {
      if (prev.size === 0) return prev;
      const ids = new Set(rules.map((r) => r.id));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [rules, invalidatePaused]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
  }, [rules]);

  // 撤销 / 重做恢复的是完整规则快照，旧轨迹引用的是旧快照，因此同时清空当前模拟轨迹
  const undo = useCallback(() => {
    const ok = hist.undo();
    if (ok) setSim(null);
    return ok;
  }, [hist]);
  const redo = useCallback(() => {
    const ok = hist.redo();
    if (ok) setSim(null);
    return ok;
  }, [hist]);

  // Ctrl/Cmd+Z 撤销、Ctrl/Cmd+Shift+Z 重做；焦点在输入控件时交给浏览器原生编辑行为
  useEffect(() => {
    if (pendingShare) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pendingShare, undo, redo]);

  // 监听浏览器前进 / 后退或手工改写 hash 带来的分享链接变化
  useEffect(() => {
    const onHashChange = () => setPendingShare(readPendingShare());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const run = () => {
    // 普通「运行」保持原有行为：一次性给出完整轨迹，与调试会话无关
    setDebug(null);
    setStaleDebug(null);
    setSim(simulate(rules, method, url));
  };

  const toggleBreakpoint = (ruleId: string) => {
    // 断点切换不视为规则变化，暂停中的会话可继续（继续时读取最新断点集）
    setBreakpoints((prev) => {
      const next = new Set(prev);
      if (next.has(ruleId)) next.delete(ruleId);
      else next.add(ruleId);
      return next;
    });
  };

  const startSession = () => {
    setStaleDebug(null);
    setSim(null);
    setDebug(startDebug(rules, method, url, breakpoints));
  };

  const stepSession = () => {
    const current = debugRef.current;
    if (current && current.phase === 'paused') {
      setDebug(stepDebug(current, rules));
    }
  };

  const continueSession = () => {
    const current = debugRef.current;
    if (current && current.phase === 'paused') {
      setDebug(continueDebug(current, rules, breakpoints));
    }
  };

  const stopSession = () => {
    setDebug(null);
    setStaleDebug(null);
  };

  // 请求方法 / URL 变化同样使暂停会话作废（旧会话是按旧请求执行的）
  const changeMethod = (m: string) => {
    invalidatePaused('请求方法已变化，暂停的调试会话已作废，请重新开始调试。');
    setMethod(m);
  };
  const changeUrl = (u: string) => {
    invalidatePaused('请求 URL 已变化，暂停的调试会话已作废，请重新开始调试。');
    setUrl(u);
  };

  // 用户在预览页确认：此刻才真正替换状态，同时清空旧轨迹与地址栏 hash。
  // 分享导入相当于换了一份文档，撤销 / 重做分支一并清空。
  const confirmImport = (payload: SharePayload) => {
    hist.reset(payload.rules);
    setMethod(payload.method);
    setUrl(payload.url);
    setSim(null);
    setDebug(null);
    setStaleDebug(null);
    removeShareHash();
    setPendingShare(null);
  };

  // 用户放弃导入：仅移除 hash 回到调试台，当前规则表 / 请求 / 轨迹一概不动
  const abortImport = () => {
    removeShareHash();
    setPendingShare(null);
  };

  // 创建者关闭分享对话框：清掉自己刚写入地址栏的 hash（复制出的链接不受影响）
  const closeShareDialog = () => {
    setSharing(false);
    removeShareHash();
  };

  if (pendingShare) {
    return (
      <ShareUnlock
        fragment={pendingShare}
        onConfirm={confirmImport}
        onAbort={abortImport}
      />
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>URL 路由规则调试台</h1>
        <p>
          编排有序规则（方法 / 主机 / 路径模板 / 查询参数条件 → 重写、重定向或停止），模拟请求逐步追踪命中过程。
          重写后从第一条规则重新匹配；以「方法 + URL」识别循环，最多执行 20 步。
        </p>
      </header>
      <main className="layout">
        <RulesPanel
          history={{ ...hist, undo, redo }}
          breakpoints={breakpoints}
          onToggleBreakpoint={toggleBreakpoint}
          onShare={() => setSharing(true)}
        />
        <div className="right-col">
          <Simulator
            method={method}
            url={url}
            onMethodChange={changeMethod}
            onUrlChange={changeUrl}
            onRun={run}
            onDebugStart={startSession}
            breakpointCount={breakpoints.size}
          />
          {staleDebug && !debug && (
            <div className="banner warn">
              {staleDebug}
              <button className="banner-dismiss" onClick={() => setStaleDebug(null)}>
                知道了
              </button>
            </div>
          )}
          {debug ? (
            <DebugPanel
              session={debug}
              onStep={stepSession}
              onContinue={continueSession}
              onStop={stopSession}
            />
          ) : (
            sim && <TraceView sim={sim} />
          )}
        </div>
      </main>
      <RegressionPanel rules={rules} />
      {sharing && (
        <ShareCreateDialog
          rules={rules}
          method={method}
          url={url}
          onClose={closeShareDialog}
        />
      )}
    </div>
  );
}
