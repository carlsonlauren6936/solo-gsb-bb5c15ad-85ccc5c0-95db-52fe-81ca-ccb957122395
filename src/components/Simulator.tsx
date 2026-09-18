import { useState } from 'react';
import { REQUEST_METHODS } from '../types';
import { PRESETS } from '../samples';

interface Props {
  method: string;
  url: string;
  onMethodChange: (m: string) => void;
  onUrlChange: (u: string) => void;
  onRun: () => void;
  onDebugStart: () => void;
  /** 已设置断点的规则数，为 0 时调试按钮给出说明性 title */
  breakpointCount: number;
}

export function Simulator({
  method,
  url,
  onMethodChange,
  onUrlChange,
  onRun,
  onDebugStart,
  breakpointCount,
}: Props) {
  const [touched, setTouched] = useState(false);
  const invalid = touched && url.trim() === '';

  const submit = (kind: 'run' | 'debug') => {
    setTouched(true);
    if (url.trim() === '') return;
    if (kind === 'run') onRun();
    else onDebugStart();
  };

  return (
    <section className="panel">
      <h2>模拟请求</h2>
      <form
        className="sim-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit('run');
        }}
      >
        <select value={method} onChange={(e) => onMethodChange(e.target.value)}>
          {REQUEST_METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <input
          className={invalid ? 'invalid' : ''}
          value={url}
          placeholder="http://api.example.com/v1/users/42"
          spellCheck={false}
          onChange={(e) => onUrlChange(e.target.value)}
        />
        <button type="submit" className="primary">
          运行
        </button>
        <button
          type="button"
          onClick={() => submit('debug')}
          title={
            breakpointCount === 0
              ? '尚未设置断点：将直接运行到终止（先在规则卡上点「断点」）'
              : `暂停在首条带断点的命中规则前（已设 ${breakpointCount} 个断点）`
          }
        >
          ⏸ 开始调试
        </button>
      </form>
      {invalid && <div className="banner error">请输入待模拟的 URL</div>}
      <div className="presets">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            className="chip"
            title={p.url}
            onClick={() => {
              onMethodChange(p.method);
              onUrlChange(p.url);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
    </section>
  );
}
