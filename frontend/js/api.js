const Api = (() => {
  const key = 'kavryon_token';
  const refreshKey = 'kavryon_refresh';
  if (!localStorage.getItem(key) && localStorage.getItem('vyntrix_token')) {
    localStorage.setItem(key, localStorage.getItem('vyntrix_token'));
    localStorage.removeItem('vyntrix_token');
  }
  function token() { return localStorage.getItem(key); }
  function setToken(t) { t ? localStorage.setItem(key, t) : localStorage.removeItem(key); }
  function refreshToken() { return localStorage.getItem(refreshKey); }
  function setRefresh(t) { t ? localStorage.setItem(refreshKey, t) : localStorage.removeItem(refreshKey); }
  function clearAuth() { setToken(null); setRefresh(null); }

  let refreshing = null;
  async function tryRefresh() {
    if (refreshing) return refreshing;
    const rt = refreshToken();
    if (!rt) return false;
    refreshing = (async () => {
      try {
        const res = await fetch(apiUrl('/api/auth/refresh'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: rt })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { clearAuth(); return false; }
        setToken(data.token);
        if (data.refreshToken) setRefresh(data.refreshToken);
        return true;
      } catch {
        clearAuth();
        return false;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  function apiUrl(path) {
    const base = (typeof window !== 'undefined' && window.KAVRYON_API_BASE) ? window.KAVRYON_API_BASE.replace(/\/$/, '') : '';
    return base ? base + path : path;
  }
  async function req(path, opts = {}, retried = false) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (token()) headers.Authorization = 'Bearer ' + token();
    const res = await fetch(apiUrl(path), { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    if (res.status === 401 && !retried && !path.includes('/auth/login') && !path.includes('/auth/signup') && !path.includes('/auth/refresh')) {
      const ok = await tryRefresh();
      if (ok) return req(path, opts, true);
      clearAuth();
      throw new Error('Login expired');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  return {
    token, setToken, setRefresh, clearAuth, refreshToken, req,
    signup: (b) => req('/api/auth/signup', { method: 'POST', body: b }),
    login: (b) => req('/api/auth/login', { method: 'POST', body: b }),
    logout: () => req('/api/auth/logout', { method: 'POST', body: {} }),
    me: () => req('/api/auth/me'),
    discover: (c) => req('/api/games/discover' + (c ? '?category=' + encodeURIComponent(c) : '')),
    searchGames: (q, page = 1) => req('/api/games/search?q=' + encodeURIComponent(q) + '&page=' + page),
    game: (id) => req('/api/games/' + id),
    play: (id, serverId) => req('/api/games/' + id + '/play', { method: 'POST', body: serverId ? { serverId } : {} }),
    wallet: () => req('/api/wallet'),
    packages: () => req('/api/wallet/packages'),
    intent: (productId) => req('/api/wallet/purchase/intent', { method: 'POST', body: { productId } }),
    complete: (body) => req('/api/wallet/purchase/complete', { method: 'POST', body }),
    devMode: () => req('/api/wallet/developer-mode', { method: 'POST', body: {} }),
    friends: () => req('/api/friends'),
    searchUsers: (u) => req('/api/users/search?username=' + encodeURIComponent(u)),
    addFriend: (username) => req('/api/friends/request', { method: 'POST', body: { username } }),
    accept: (requestId) => req('/api/friends/accept', { method: 'POST', body: { requestId } }),
    decline: (requestId) => req('/api/friends/decline', { method: 'POST', body: { requestId } }),
    removeFriend: (userId) => req('/api/friends/remove', { method: 'POST', body: { userId } }),
    
    collabInfo: (gameId) => req('/api/games/' + encodeURIComponent(gameId) + '/collab'),
    collabInvite: (gameId, username, role) => req('/api/games/' + encodeURIComponent(gameId) + '/collab/invite', { method: 'POST', body: { username, role } }),
    collabSetRole: (gameId, userId, role) => req('/api/games/' + encodeURIComponent(gameId) + '/collab/role', { method: 'POST', body: { userId, role } }),
    collabRemove: (gameId, userId) => req('/api/games/' + encodeURIComponent(gameId) + '/collab/remove', { method: 'POST', body: { userId } }),
    collabBump: (gameId, baseRevision) => req('/api/games/' + encodeURIComponent(gameId) + '/collab/revision', { method: 'POST', body: { baseRevision } }),
    collabInvites: () => req('/api/collab/invites'),
    collabAccept: (id) => req('/api/collab/invites/' + encodeURIComponent(id) + '/accept', { method: 'POST', body: {} }),
    collabDecline: (id) => req('/api/collab/invites/' + encodeURIComponent(id) + '/decline', { method: 'POST', body: {} }),
    bdPaymentStatus: () => req('/api/payments/bd/status'),
    bdCreateOrder: (productId) => req('/api/payments/bd/create-order', { method: 'POST', body: { productId } }),
    bdOrders: () => req('/api/payments/bd/orders'),
    videosPublic: (page, gameId) => req('/api/videos?page=' + (page||1) + (gameId ? '&gameId=' + encodeURIComponent(gameId) : '')),
    videosMine: () => req('/api/videos/mine'),
    video: (id) => req('/api/videos/' + encodeURIComponent(id)),
    userVideos: (username) => req('/api/users/' + encodeURIComponent(username) + '/videos'),
    videoSettings: () => req('/api/users/me/video-settings'),
    setVideoSettings: (body) => req('/api/users/me/video-settings', { method: 'PUT', body }),
    updateVideo: (id, body) => req('/api/videos/' + encodeURIComponent(id), { method: 'PATCH', body }),
    deleteVideo: (id) => req('/api/videos/' + encodeURIComponent(id), { method: 'DELETE' }),
    reportVideo: (id, reason) => req('/api/videos/' + encodeURIComponent(id) + '/report', { method: 'POST', body: { reason } }),
    uploadVideo: async (formData, onProgress) => {
      const base = (typeof KAVRYON_API_BASE !== 'undefined' && KAVRYON_API_BASE) || '';
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', base + '/api/videos/upload');
        const tok = token();
        if (tok) xhr.setRequestHeader('Authorization', 'Bearer ' + tok);
        xhr.upload.onprogress = (e) => {
          if (onProgress && e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
          let data = {};
          try { data = JSON.parse(xhr.responseText); } catch (_) {}
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else reject(new Error(data.error || ('Upload failed ' + xhr.status)));
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send(formData);
      });
    },
    videoStreamTicket: (id) => req('/api/videos/' + encodeURIComponent(id) + '/stream-ticket-public', { method: 'POST', body: {} }),
    videoStreamUrl: async (id) => {
      const base = (typeof KAVRYON_API_BASE !== 'undefined' && KAVRYON_API_BASE) || '';
      try {
        const r = await req('/api/videos/' + encodeURIComponent(id) + '/stream-ticket-public', { method: 'POST', body: {} });
        return base + '/api/videos/' + encodeURIComponent(id) + '/stream?ticket=' + encodeURIComponent(r.ticket);
      } catch (_) {
        return base + '/api/videos/' + encodeURIComponent(id) + '/stream';
      }
    },
    createGame: (b) => req('/api/games', { method: 'POST', body: b }),
    saveObjects: (id, objects) => req('/api/games/' + id + '/objects', { method: 'PUT', body: { objects } }),
    saveScripts: (id, scripts) => req('/api/games/' + id + '/scripts', { method: 'PUT', body: { scripts } }),
    validateGame: (id) => req('/api/games/' + id + '/validate', { method: 'POST', body: {} }),
    publish: (id, body={}) => req('/api/games/' + id + '/publish', { method: 'POST', body }),
    unpublish: (id) => req('/api/games/' + id + '/unpublish', { method: 'POST', body: {} }),
    feedNew: () => req('/api/games/feed/new'),
    inviteFriends: () => req('/api/invites/friends'),
    sendInvite: (b) => req('/api/invites', { method: 'POST', body: b }),
    respondInvite: (id, action) => req('/api/invites/' + id + '/respond', { method: 'POST', body: { action } }),
    testServer: (id) => req('/api/games/' + id + '/test-server', { method: 'POST', body: {} }),
    mine: () => req('/api/games/mine'),
    dash: () => req('/api/creator/dashboard'),
    updateGame: (id, b) => req('/api/games/' + id, { method: 'PUT', body: b }),
    like: (id) => req('/api/games/' + id + '/like', { method: 'POST', body: {} }),
    fav: (id) => req('/api/games/' + id + '/favorite', { method: 'POST', body: {} }),
    report: (b) => req('/api/reports', { method: 'POST', body: b }),
    profile: (b) => req('/api/users/me/profile', { method: 'PUT', body: b }),
    inventory: () => req('/api/inventory'),
    adminOverview: () => req('/api/admin/overview'),
    giftSend: (b) => req('/api/gifts/send', { method: 'POST', body: b }),
    giftHistory: (limit = 20, offset = 0) => req('/api/gifts/history?limit=' + limit + '&offset=' + offset),
    notifications: () => req('/api/notifications'),
    readNotifications: (id) => req('/api/notifications/read', { method: 'POST', body: id ? { id } : {} }),
    ownerCommand: (command) => req('/api/owner/command', { method: 'POST', body: { command } }),
    aiTools: () => req('/api/studio/ai/tools'),
    aiProvidersCatalog: () => req('/api/studio/ai/providers/catalog'),
    aiProviders: () => req('/api/studio/ai/providers'),
    aiProviderAdd: (b) => req('/api/studio/ai/providers', { method: 'POST', body: b }),
    aiProviderRemove: (id) => req('/api/studio/ai/providers/' + id, { method: 'DELETE' }),
    aiProviderDefault: (id) => req('/api/studio/ai/providers/' + id + '/default', { method: 'POST', body: {} }),
    aiProviderTest: (id) => req('/api/studio/ai/providers/' + id + '/test', { method: 'POST', body: {} }),
    aiPlan: (b) => req('/api/studio/ai/plan', { method: 'POST', body: b }),
    marketplace: (q) => req('/api/marketplace' + (q ? '?' + new URLSearchParams(q).toString() : '')),
    publishAsset: (b) => req('/api/marketplace/assets', { method: 'POST', body: b }),
    buyAsset: (id, b) => req('/api/marketplace/assets/' + id + '/buy', { method: 'POST', body: b || {} }),
    myAssets: () => req('/api/marketplace/mine'),
    cloudSave: (id, b) => req('/api/games/' + id + '/cloud-save', { method: 'POST', body: b }),
    cloudLoad: (id, slot) => req('/api/games/' + id + '/cloud-save?slot=' + (slot||0)),
    privateServer: (id, b) => req('/api/games/' + id + '/private-servers', { method: 'POST', body: b }),
    joinPrivate: (id, b) => req('/api/private-servers/' + id + '/join', { method: 'POST', body: b || {} }),
    follow: (username) => req('/api/follow', { method: 'POST', body: { username } }),
    unfollow: (userId) => req('/api/unfollow', { method: 'POST', body: { userId } }),
    avatar: () => req('/api/avatar'),
    setAvatar: (b) => req('/api/avatar', { method: 'PUT', body: b }),
    groups: () => req('/api/groups'),
    createGroup: (b) => req('/api/groups', { method: 'POST', body: b }),
    analytics: () => req('/api/creator/analytics'),
    listPasses: (gameId) => req('/api/games/' + gameId + '/passes'),
    createPass: (gameId, b) => req('/api/games/' + gameId + '/passes', { method: 'POST', body: b }),
    buyPass: (id, b) => req('/api/passes/' + id + '/buy', { method: 'POST', body: b || {} }),
    passStats: () => req('/api/creator/pass-stats'),

    rollback: (id, version) => req('/api/games/' + id + '/rollback', { method: 'POST', body: { version } }),


    aiTool: (b) => req('/api/studio/ai/tool', { method: 'POST', body: b }),
    aiBuild: (b) => req('/api/studio/ai/build', { method: 'POST', body: b })
  };
})();
