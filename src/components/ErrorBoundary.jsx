import { t } from '../i18n';
import React from 'react';
import './ErrorBoundary.css';

export default class ErrorBoundary extends React.Component {
  state = { failed: false, error: null };

  static getDerivedStateFromError(error) {
    return { failed: true, error: error?.stack || String(error) };
  }

  componentDidCatch(error, info) {
    console.error('ErrorBoundary caught:', error, info);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="error-boundary" style={{ padding: '24px', fontFamily: 'sans-serif' }}>
      <div role="alert">
        <h1 style={{ color: '#d32f2f' }}>{t("界面出现异常")}</h1>
        <p>{t("请重新加载后继续使用。若仍出现此提示，请关闭并重新打开应用。")}</p>
        {this.state.error && <pre style={{ background: '#f5f5f5', padding: '16px', borderRadius: '8px', overflow: 'auto', textAlign: 'left', fontSize: '12px', whiteSpace: 'pre-wrap' }}>{this.state.error}</pre>}
      </div>
      <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>{t("重新加载")}</button>
    </main>;
  }
}
