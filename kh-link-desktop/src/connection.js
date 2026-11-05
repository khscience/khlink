(function (root) {
  function view(state, now = Date.now()) {
    const connector = state?.connector || {};
    const direct = (state?.connectionMode || connector.connectionMode) === 'direct';
    const authenticated = state?.authenticated === true;
    const at = Number(connector.updatedAt || connector.updated_at || 0);
    const fresh = at > 0 && now - at <= 15_000;
    const running = fresh && !['stopped', 'stopping'].includes(connector.lifecycle);
    const matching = !connector.connectionMode || connector.connectionMode === (direct ? 'direct' : 'server');
    const online = fresh && matching && (direct ? connector.directConnected === true :
      connector.connected === true || connector.online === true || connector.state === 'online');
    const loginRequired = !direct && !authenticated;
    return { direct, authenticated, fresh, running, online, loginRequired,
      age: at > 0 ? Math.max(0, Math.floor((now - at) / 1000)) : null,
      title: direct ? (online ? '手机已直连' : '直连未连接') : online ? (authenticated ? '账户连接正常' : '后台连接正常') : loginRequired ? '请登录账户' : '账户连接未建立',
      action: direct ? (online ? '查看直连' : '配对手机') : loginRequired ? '登录账户' : '重新连接',
    };
  }
  root.KhConnection = { view };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.KhConnection;
})(globalThis);
