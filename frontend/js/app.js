const state = { user: null, tab: 'home', stack: [], view: null, payload: null };

/** Inline SVG icon from local sprite symbols (no emoji, no CDN). */
function icon(name, cls) {
  return `<svg class="icon ${cls || ''}" aria-hidden="true"><use href="assets/icons/sprite.svg#i-${name}"></use></svg>`;
}
function toast(msg, kind) {
  let host = document.querySelector('.toast-host');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toast-host';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = String(msg || '');
  host.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}


const $ = (s) => document.querySelector(s);
const app = () => document.getElementById('app');

function go(view, payload, push = true) {
  if (push && state.view) state.stack.push({ view: state.view, payload: state.payload, tab: state.tab });
  state.view = view;
  state.payload = payload;
  render();
}
function back() {
  const prev = state.stack.pop();
  if (!prev) {
    if (state.view === 'play' || state.view === 'game' || state.view === 'editor') {
      go('discover', null, false);
      return true;
    }
    return false;
  }
  state.view = prev.view;
  state.payload = prev.payload;
  state.tab = prev.tab;
  render();
  return true;
}
window.addEventListener('popstate', (e) => {
  if (back()) history.pushState({ v: 1 }, '');
});
history.pushState({ v: 1 }, '');

async 
function renderGameCards(games) {
  if (!games || !games.length) {
    return `<div class="empty">${icon('game', 'icon-xl')}<p>No games here yet.</p><p class="muted">Publish from Create to appear in Discover.</p></div>`;
  }
  return `<div class="grid">${games.map(g => `
    <button type="button" class="card game-card clickable" data-gid="${esc(g.id)}">
      <div class="thumb">${g.thumbnail ? `<img src="${esc(g.thumbnail)}" alt="" loading="lazy"/>` : `<div class="thumb-ph">${esc((g.name || '?').slice(0, 2).toUpperCase())}</div>`}</div>
      <div class="name">${esc(g.name)}</div>
      <div class="meta">@${esc(g.creator || '')} · ${g.plays || 0} plays · ${g.likes || 0} likes</div>
    </button>`).join('')}</div>`;
}


/** Android Play Billing: never credit client-side — POST token to backend. */
async function purchaseKavxNative(productId) {
  if (typeof KavryonBilling === 'undefined' || !KavryonBilling.isReady()) {
    toast('In-app billing unavailable on this device');
    return;
  }
  window.__kavryonPurchaseResult = async (result) => {
    try {
      if (result.error) { toast('Purchase failed: ' + result.error); return; }
      if (result.responseCode !== 0 && result.responseCode !== undefined) {
        if (result.responseCode === 1) toast('Purchase cancelled');
        else toast('Billing error ' + result.responseCode);
        return;
      }
      const purchases = result.purchases || [];
      for (const p of purchases) {
        // Android Purchase.PurchaseState.PURCHASED is 1; pending purchases
        // must never be acknowledged or presented as granted in the UI.
        if (p.purchaseState !== 1) {
          toast(p.purchaseState === 2 ? 'Purchase pending; Kavx will arrive after verification' : 'Purchase is not completed');
          continue;
        }
        const purchasedProductId = (p.products && p.products[0]) || productId;
        if (!purchasedProductId || !p.purchaseToken) {
          toast('Purchase response was incomplete');
          continue;
        }
        const r = await Api.complete({
          productId: purchasedProductId,
          purchaseToken: p.purchaseToken,
          packageName: 'com.kavryon.platform'
        });
        if (r && r.balance != null && state.user) state.user.kavx = r.balance;
        toast('Kavx added after verification');
        if (typeof KavryonBilling.acknowledgePurchase === 'function') {
          KavryonBilling.acknowledgePurchase(p.purchaseToken);
        }
      }
      render();
    } catch (e) { toast(e.message || 'Verify failed'); }
  };
  KavryonBilling.launchPurchase(productId);
}

async function boot() {
  if (Api.token()) {
    try {
      state.user = (await Api.me()).user;
    } catch {
      if (Api.clearAuth) Api.clearAuth();
      else Api.setToken(null);
    }
  }
  state.view = state.user ? 'home' : 'auth';
  await render();
}

function shell(inner) {
  const u = state.user;
  const tab = state.tab || 'home';
  const nav = [
    ['home', 'Home', 'home'],
    ['discover', 'Discover', 'compass'],
    ['videos', 'Videos', 'video'],
    ['create', 'Create', 'plus'],
    ['friends', 'Friends', 'users'],
    ['profile', 'Profile', 'user']
  ];
  return `
    <div class="topbar">
      <div class="brand-lockup">
        <img class="logo" src="assets/images/branding/kavryon-icon.svg" alt="" width="28" height="28" />
        <div class="brand">KAVRYON</div>
      </div>
      <div class="search-wrap">
        ${icon('search')}
        <input class="search" id="q" type="search" placeholder="Search games or @user" aria-label="Search" autocomplete="off" />
      </div>
      <button type="button" class="kavx-chip" id="openStore" aria-label="Open Kavx store">
        <img src="assets/images/branding/kavx-icon.svg" width="16" height="16" alt="" />
        <span>${u ? u.kavx : 0}</span>
      </button>
    </div>
    <div class="shell">
      <nav class="nav mobile-only-nav" aria-label="Main">
        ${nav.map(([id, label, ic]) => `
          <button type="button" data-tab="${id}" class="${tab === id ? 'on' : ''}" aria-current="${tab === id ? 'page' : 'false'}">
            ${icon(ic)}
            <span>${label}</span>
          </button>`).join('')}
      </nav>
      <div class="shell-main"><div class="wrap">${inner}</div></div>
    </div>`;
}

async function render() {
  if (!state.user && state.view !== 'auth') { state.view = 'auth'; }
  if (state.view === 'auth') { app().innerHTML = authView(); bindAuth(); return; }
  try {
    if (state.view === 'home') app().innerHTML = shell(await homeView());
    else if (state.view === 'discover') app().innerHTML = shell(await discoverView());
    else if (state.view === 'create') app().innerHTML = shell(await createView());
    else if (state.view === 'friends') app().innerHTML = shell(await friendsView());
    else if (state.view === 'videos') app().innerHTML = shell(await videosView());
    else if (state.view === 'myVideos') app().innerHTML = shell(await myVideosView());
    else if (state.view === 'video') app().innerHTML = shell(await videoWatchView(state.payload));
    else if (state.view === 'profile') app().innerHTML = shell(await profileView());
    else if (state.view === 'store') app().innerHTML = shell(await storeView());
    else if (state.view === 'groups') app().innerHTML = shell(await groupsView());
    else if (state.view === 'market') app().innerHTML = shell(await marketView());
    else if (state.view === 'avatar') app().innerHTML = shell(await avatarView());
    else if (state.view === 'wallet') app().innerHTML = shell(await walletView());
    else if (state.view === 'game') app().innerHTML = shell(await gamePage(state.payload));
    else if (state.view === 'editor') app().innerHTML = shell(await editorView(state.payload));
    else if (state.view === 'play') app().innerHTML = shell(await playView(state.payload));
    else if (state.view === 'dash') app().innerHTML = shell(await dashView());
    else app().innerHTML = shell('<p>Unknown view</p>');
  } catch (e) {
    app().innerHTML = shell(`<p class="err">${e.message}</p>`);
  }
  bindShell();
}

function authView() {
  return `<div class="auth">
    <img src="assets/images/branding/kavryon-icon.svg" width="64" />
    <h1>KAVRYON</h1>
    <p class="muted">Original multiplayer worlds. Premium Kavx only from verified purchases.</p>
    <input id="user" placeholder="Username" />
    <input id="pass" type="password" placeholder="Password (8+ chars)" />
    <input id="disp" placeholder="Display name (optional)" />
    <div class="row">
      <button class="btn" id="login">Log In</button>
      <button class="ghost" id="signup">Sign Up</button>
    </div>
    <p id="msg" class="err"></p>
  </div>`;
}
function bindAuth() {
  const msg = $('#msg');
  $('#login').onclick = async () => {
    try {
      const r = await Api.login({ username: $('#user').value, password: $('#pass').value });
      Api.setToken(r.token); if (r.refreshToken) Api.setRefresh(r.refreshToken); state.user = r.user; go('home', null, false);
    } catch (e) { msg.textContent = e.message; }
  };
  $('#signup').onclick = async () => {
    try {
      const r = await Api.signup({ username: $('#user').value, password: $('#pass').value, displayName: $('#disp').value });
      Api.setToken(r.token); if (r.refreshToken) Api.setRefresh(r.refreshToken); state.user = r.user; go('home', null, false);
    } catch (e) { msg.textContent = e.message; }
  };
}

async function homeView() {
  let newest = [];
  let trending = [];
  try {
    const d = await Api.discover();
    newest = d.newest || d.games || [];
    trending = d.trending || d.featured || newest;
  } catch (_) {}
  const featured = (trending.length ? trending : newest).slice(0, 8);
  const rest = (newest.length ? newest : featured).slice(0, 24);
  return `
    <div class="lobby-hero">
      <h1>Play something new</h1>
      <p class="muted">Discover experiences from Kavryon creators. Creator Mode is free — build, test, and publish.</p>
    </div>
    <div class="section-title">Featured</div>
    <div class="feat-row">${featured.length ? featured.map(g => `
      <button type="button" class="card game-card clickable" data-gid="${esc(g.id)}">
        <div class="thumb">${g.thumbnail ? `<img src="${esc(g.thumbnail)}" alt="" loading="lazy"/>` : `<div class="thumb-ph">${esc((g.name||'?').slice(0,2).toUpperCase())}</div>`}</div>
        <div class="name">${esc(g.name)}</div>
        <div class="meta">@${esc(g.creator||'')} · ${g.plays||0} plays</div>
      </button>`).join('') : `<div class="empty"><p class="muted">No games yet — publish from Create.</p></div>`}</div>
    <div class="section-title">Experiences</div>
    ${await renderGameCards(rest)}
  `;
}

function gameThumb(g) {
  const src = g.thumbnail && String(g.thumbnail).trim();
  if (src && (src.startsWith('data:image/') || src.startsWith('/') || src.startsWith('assets/') || src.startsWith('http'))) {
    return `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'thumb-ph',textContent:'${esc((g.name||'K')[0]).toUpperCase()}'}))"/>`;
  }
  return `<div class="thumb-ph">${esc((g.name || 'K')[0]).toUpperCase()}</div>`;
}
function gameCard(g) {
  return `<div class="card game" data-id="${g.id}">
    <div class="thumb">${gameThumb(g)}</div>
    <h3>${esc(g.name)}</h3>
    <div class="muted">@${esc(g.creator)} · ${g.currentPlayers || 0}/${g.max_players}</div>
    <span class="pill">${g.likes || 0} likes</span>
  </div>`;
}
function empty() { return '<p class="muted">Nothing here yet.</p>'; }
function esc(s) { return String(s || '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

async function discoverView() {
  if (state.payload && state.payload.search) {
    return `<h2>Search: ${esc(state.payload.q||'')}</h2><div class="grid">${state.payload.search.map(gameCard).join('') || empty()}</div>`;
  }
  const cat = state.payload && state.payload.category;
  const d = await Api.discover(cat);
  const sec = (title, list) => `<h3 style="margin-top:12px">${title}</h3><div class="grid">${(list||[]).map(gameCard).join('') || empty()}</div>`;
  return `<h2>Discover</h2>
    <div class="chips">${['All'].concat(d.categories||[]).map(c => `<button class="ghost" data-cat="${c==='All'?'':c}">${c}</button>`).join('')}</div>
    ${sec('New & Just Published', d.newest)}
    ${sec('Trending', d.trending)}
    ${sec('Popular', d.popular)}
    ${sec('All Games', d.all || d.games)}`;
}

async function createView() {
  // Creator Mode is free — ensure flag
  if (!state.user.developer_mode) state.user.developer_mode = true;
  const mine = await Api.mine();
  return `<h2>Create</h2>
    <button class="btn" id="newGame">Create Game</button>
    <button class="ghost" id="toDash">Creator Dashboard</button>
    <div class="list" style="margin-top:12px">${mine.games.map(g => `<div class="card row"><div><b>${esc(g.name)}</b><div class="muted">${g.state}</div></div>
      <button class="ghost editg" data-id="${g.id}">Edit</button></div>`).join('') || empty()}</div>
    <div id="newForm" hidden class="card" style="margin-top:12px">
      <input id="gn" placeholder="Name" /><textarea id="gd" placeholder="Description"></textarea>
      <select id="gc">${['Adventure','Horror','Survival','Racing','Simulator','Strategy','RPG','Puzzle','Platform','Casual','Arena'].map(c=>`<option>${c}</option>`).join('')}</select>
      <select id="gt">${['Empty World','Obby','Platformer','Team Battle','BedWars','Survival','Racing','Tycoon','Simulator','RPG','Adventure','Horror','Arena'].map(c=>`<option>${c}</option>`).join('')}</select><label class="muted">Dimension</label><select id="gdim"><option value="2d">2D</option><option value="3d">3D</option></select>
      <input id="gm" type="number" min="2" max="50" value="8" />
      <button class="btn" id="saveNew">Save Draft</button>
    </div>`;
}

async function friendsView() {
  const f = await Api.friends();
  return `<h2>Friends</h2>
    <input id="fs" placeholder="Search username..." />
    <button class="btn" id="fsearch">Search</button>
    <div id="fresults"></div>
    <h3>Friend Requests</h3>
    <div class="list">${f.incoming.map(r => `<div class="card row"><div><b>${esc(r.username)}</b> wants to add you.</div>
      <div><button class="btn acc" data-id="${r.id}">ACCEPT</button> <button class="ghost dec" data-id="${r.id}">DECLINE</button></div></div>`).join('') || '<p class="muted">None</p>'}</div>
    <h3>Friends</h3>
    <div class="list">${f.friends.map(p => `<div class="card row"><div><b>${esc(p.username)}</b><div class="muted">${esc(p.presence.status)}${p.presence.game? ' · Playing: '+esc(p.presence.game):''}</div></div>
      <div><button class="ghost giftBtn" data-u="${esc(p.username)}">Gift</button>${p.presence.status==='playing'&&p.presence.gameId?` <button class="ghost joinFriend" data-gid="${p.presence.gameId}" data-sid="${p.presence.serverId||''}">Join</button>`:''}</div></div>`).join('') || empty()}</div>
    <div id="giftModal" hidden></div>`;
}


async function videosView() {
  let list = [];
  let err = '';
  try {
    const r = await Api.videosPublic(1);
    list = r.videos || [];
  } catch (e) { err = e.message || 'Failed to load'; }
  const cards = list.length ? `<div class="grid">${list.map(v => `
    <button type="button" class="card game-card clickable" data-vid="${esc(v.id)}">
      <div class="thumb video-thumb">${icon('video', 'icon-lg')}</div>
      <div class="name">${esc(v.title)}</div>
      <div class="meta">@${esc(v.owner?.username || '')}${v.game ? ' · ' + esc(v.game.name) : ''}</div>
    </button>`).join('')}</div>` : `<div class="empty">${icon('video', 'icon-xl')}<p>No public clips yet.</p><p class="muted">Upload from Profile → My Videos.</p></div>`;
  return `<h2 class="page-title">Videos</h2>
    <p class="muted">Gameplay clips from the community.</p>
    ${err ? `<p class="err">${esc(err)}</p>` : ''}
    <div class="row between" style="margin:12px 0">
      <span class="muted">${list.length} clip(s)</span>
      <button type="button" class="btn secondary" id="goMyVideos">${icon('upload')} My Videos</button>
    </div>
    ${cards}`;
}

async function myVideosView() {
  let data = { videos: [], settings: { videosEnabled: true, defaultVisibility: 'public' } };
  try { data = await Api.videosMine(); } catch (e) { return `<p class="err">${esc(e.message)}</p>`; }
  const s = data.settings || {};
  const rows = (data.videos || []).map(v => `
    <div class="card" data-vid-row="${esc(v.id)}">
      <div class="row between">
        <div>
          <b>${esc(v.title)}</b>
          <div class="muted">${esc(v.visibility)} · ${esc(v.status)}${v.game ? ' · ' + esc(v.game.name) : ''}</div>
        </div>
        <div class="row">
          <button type="button" class="btn sm secondary vid-open" data-id="${esc(v.id)}">Open</button>
          <button type="button" class="btn sm ghost vid-del" data-id="${esc(v.id)}">Delete</button>
        </div>
      </div>
    </div>`).join('') || `<div class="empty"><p>You have no clips yet.</p></div>`;
  return `<h2 class="page-title">My Videos</h2>
    <div class="card stack" style="margin-bottom:16px">
      <h3>Video settings</h3>
      <label class="row"><input type="checkbox" id="vidEnabled" ${s.videosEnabled ? 'checked' : ''}/> Show public Video section on my profile</label>
      <label>Default visibility
        <select id="vidDefaultVis">
          <option value="public" ${s.defaultVisibility==='public'?'selected':''}>Public</option>
          <option value="unlisted" ${s.defaultVisibility==='unlisted'?'selected':''}>Unlisted</option>
          <option value="private" ${s.defaultVisibility==='private'?'selected':''}>Private</option>
        </select>
      </label>
      <button type="button" class="btn sm" id="saveVidSettings">Save settings</button>
      <p id="vidSetMsg" class="muted"></p>
    </div>
    <div class="card stack" style="margin-bottom:16px">
      <h3>Upload clip</h3>
      <p class="muted">MP4 or WebM, max 50 MB. Server validates file type.</p>
      <label>Title <input id="vidTitle" maxlength="80" placeholder="Clip title"/></label>
      <label>Description <textarea id="vidDesc" maxlength="500" rows="2"></textarea></label>
      <label>Visibility
        <select id="vidVis">
          <option value="public">Public</option>
          <option value="unlisted">Unlisted</option>
          <option value="private" selected>Private</option>
        </select>
      </label>
      <label>Game ID (optional published game) <input id="vidGameId" placeholder="game uuid"/></label>
      <label>File <input type="file" id="vidFile" accept="video/mp4,video/webm,.mp4,.webm"/></label>
      <div class="row"><button type="button" class="btn" id="vidUpload">${icon('upload')} Upload</button>
      <span id="vidProg" class="muted"></span></div>
      <p id="vidMsg" class="muted"></p>
    </div>
    <h3>Your clips</h3>
    <div class="list">${rows}</div>`;
}

async function videoWatchView(id) {
  let v;
  try {
    const r = await Api.video(id);
    v = r.video;
  } catch (e) {
    return `<p class="err">${esc(e.message || 'Video not found')}</p><button class="btn secondary" id="backVids">Back</button>`;
  }
  const src = await Api.videoStreamUrl(v.id);
  return `<div class="row between">
      <button type="button" class="btn-icon" id="backVids" aria-label="Back">${icon('arrow-left')}</button>
      <h2 class="page-title" style="flex:1;margin:0 12px">${esc(v.title)}</h2>
    </div>
    <div class="play-wrap" style="margin:12px 0">
      <video id="clipPlayer" controls playsinline preload="metadata" style="width:100%;aspect-ratio:16/9;background:#000;border-radius:12px"
        src="${esc(src)}"></video>
    </div>
    <p class="muted">@${esc(v.owner?.username || '')}${v.game ? ' · ' + esc(v.game.name) : ''} · ${v.viewCount || 0} views</p>
    <p>${esc(v.description || '')}</p>
    <div class="row" style="gap:8px;flex-wrap:wrap">
      ${v.game ? `<button type="button" class="btn" id="openVidGame" data-gid="${esc(v.game.id)}">Open game</button>` : ''}
      <button type="button" class="btn secondary" id="reportVid">Report</button>
    </div>`;
}


async function profileView() {
  const p = state.user.profile || {};
  return `<h2>Profile</h2>
    <div class="row"><div class="avatar"></div><div><b>${esc(state.user.display_name)}</b><div class="muted">@${esc(state.user.username)}</div></div></div>
    <p>Creator Mode: <b>Free</b> (enabled for all users)</p>
    <button class="ghost" id="openWallet">Wallet & history</button>
    <button type="button" class="btn secondary" id="openMyVideos">${icon('video')} My Videos</button>
    <h3>Avatar</h3>
    ${['body','head','hair','face','outfit','accessory'].map(k => `<label>${k}<input data-av="${k}" value="${esc(p[k]||'')}" /></label>`).join('')}
    <button class="btn" id="saveAv">Save avatar</button>
    <h3>Inventory</h3><div id="inv">Loading…</div>
    ${state.user.role==='admin'||state.user.isOwner?'<h3>Admin</h3><pre id="adminBox"></pre>':''}
    ${state.user.isOwner?`<h3>Owner commands</h3><input id="ownerCmd" placeholder="/kavx grant-self 1000" /><button class="btn" id="runOwner">Run</button><p id="ownerMsg" class="muted"></p>`:''}
    <h3>Team invites</h3><div id="collabInvBox">Loading…</div>
    <h3>Notifications</h3><div id="notifBox">Loading…</div>
    <button class="warn" id="logout">Log Out</button>`;
}

async function storeView() {
  const w = await Api.wallet();
  const packs = await Api.packages();
  let bd = { available: false, message: '' };
  try { bd = await Api.bdPaymentStatus(); } catch (_) {}
  const bdNote = bd.available
    ? `<p class="ok">Bangladesh checkout (SSLCommerz) is available. Pay in BDT; Kavx is credited only after bank/MFS confirmation.</p>
       <div class="list">${(bd.packages||[]).map(p => `<div class="card row between"><span><b>${esc(p.label)}</b><div class="muted">${p.amountBdt} BDT → ${p.kavx} Kavx</div></span>
         <button type="button" class="btn bd-buy" data-id="${esc(p.productId)}">Pay BDT</button></div>`).join('')}</div>`
    : `<p class="muted">${esc(bd.message || 'Bangladesh card/MFS payments are not configured on this server yet.')}</p>`;
  return `<h2 class="page-title">Kavx Store</h2>
    <p>Your Balance: <b>${w.balance} Kavx</b></p>
    <p class="muted">Kavx is granted only after the server verifies a real payment. Play does not earn free Kavx.</p>
    <h3>Google Play (Android)</h3>
    <div class="list">${packs.packages.map(p => `<div class="card row between"><b>${esc(p.label)}</b><button type="button" class="btn buy" data-id="${esc(p.productId)}">Play Billing</button></div>`).join('')}</div>
    <h3>Bangladesh (bKash / cards via SSLCommerz)</h3>
    ${bdNote}
    <p id="smsg" class="muted"></p>`;
}

async function walletView() {
  const w = await Api.wallet();
  const gh = (w.gifts || []);
  return `<h2>Wallet</h2><p>Current Kavx: <b>${w.balance}</b> <span class="muted">(${w.currencyDisplay || 'Kavx'})</span></p>
    <h3>Transactions</h3>
    <div class="list">${w.transactions.map(t => `<div class="card row"><span>${esc(t.type)}</span><span>${t.amount}</span><span class="muted">${esc(t.status)}</span></div>`).join('') || empty()}</div>
    <h3>Gift history</h3>
    <div class="list">${gh.map(g => `<div class="card row"><span>${g.direction}</span><span>@${esc(g.counterpart)}</span><span>${g.amount} Kavx</span></div>`).join('') || empty()}</div>
    <h3>Purchases</h3>
    <div class="list">${w.purchases.map(p => `<div class="card">${esc(p.product_id)} · ${esc(p.status)}</div>`).join('') || empty()}</div>`;
}

async function gamePage(id) {
  const data = await Api.game(id);
  let passes = [];
  try { passes = (await Api.listPasses(id)).passes || []; } catch(_){}

  const game = data.game;
  const servers = (data.servers || game.servers || []).filter((s) => !s.is_test);
  const ver = game.published_version || game.version || 1;
  const pub = game.published_at ? new Date(game.published_at).toLocaleString() : '—';
  return `<button class="ghost" id="backBtn">Back</button>
    <div class="game-hero">
      <div class="thumb large">${gameThumb(game)}</div>
      <div>
        <h2>${esc(game.name)}</h2>
        <p class="muted">@${esc(game.creator)} · ${esc(game.category)} · ${esc(game.dimension||'2d').toUpperCase()}</p>
        <p class="muted">${game.currentPlayers||0}/${game.max_players} playing · ${game.plays||0} plays · ${game.likes||0} likes · v${ver}</p>
        <p class="muted">Published ${esc(pub)}</p>
      </div>
    </div>
    <p>${esc(game.description)}</p>
    <div class="row">
      <button class="btn playFirst" data-id="${game.id}">PLAY</button>
      <button class="ghost createPriv" data-id="${game.id}">Private Server</button>
      <button class="ghost like" data-id="${game.id}">${game.liked?'Liked':'Like'} ${game.likes||0}</button>
      <button class="ghost fav" data-id="${game.id}">${game.favorited?'Favorited':'Favorite'}</button>
      <button class="ghost rpt" data-id="${game.id}">Report</button>
    </div>
    ${passes.length?`<h3>Game Passes</h3><div class="list">${passes.map(p=>`<div class="card row"><div><b>${esc(p.name)}</b><div class="muted">${esc(p.description||'')} · ${p.priceKavx} Kavx</div></div>
        <button class="btn buyPass" data-id="${p.id}">Buy</button></div>`).join('')}</div><p class="muted">60% to creator · 40% to platform</p>`:''}
    <h3>Servers</h3>
    <div class="list">${servers.map((s) => {
      const n = s.players != null ? s.players : 0;
      const full = s.full || n >= s.max_players;
      return `<div class="card row"><div><b>${esc(s.name)}</b><div class="muted">${n} / ${s.max_players}</div></div>
        ${full ? '<span class="pill">FULL</span>' : `<button class="btn joinS" data-gid="${game.id}" data-sid="${s.id}">JOIN</button>`}</div>`;
    }).join('') || empty()}</div>`;
}

async function editorView(id) {
  const data = await Api.game(id);
  state.edit = { game: data.game, objects: data.objects, scripts: data.scripts || [], revision: 1, role: 'owner' };
  let team = { members: [], role: 'owner', canManage: true, canEdit: true, canPublish: true, revision: { revision: 1 }, activity: [] };
  try { team = await Api.collabInfo(id); state.edit.revision = team.revision?.revision || 1; state.edit.role = team.role; } catch (_) {}
  const membersHtml = (team.members || []).map(m => `
    <div class="card row between">
      <span><b>@${esc(m.username)}</b> · ${esc(m.role)}</span>
      ${team.canManage && m.role !== 'owner' ? `<span class="row">
        <button type="button" class="btn sm secondary collab-role" data-uid="${esc(m.userId)}" data-role="editor">Editor</button>
        <button type="button" class="btn sm secondary collab-role" data-uid="${esc(m.userId)}" data-role="viewer">Viewer</button>
        <button type="button" class="btn sm ghost collab-rm" data-uid="${esc(m.userId)}">Remove</button>
      </span>` : ''}
    </div>`).join('') || '<p class="muted">Only you so far.</p>';
  const actHtml = (team.activity || []).slice(0, 8).map(a =>
    `<div class="muted">@${esc(a.username || '?')} · ${esc(a.action)} · ${esc(a.detail || '')}</div>`
  ).join('') || '<p class="muted">No activity yet.</p>';
  return `<button class="ghost" id="backBtn">Dashboard</button>
    <h2>Editor · ${esc(data.game.name)} · ${esc(data.game.state)} · <span class="muted">${esc(team.role || '')}</span></h2>
    <p class="muted" id="collabSync">Revision ${team.revision?.revision || 1}${team.canEdit ? '' : ' · view only'}</p>
    <canvas id="stage" width="640" height="360"></canvas>
    <div class="chips" id="tools">${team.canEdit === false ? '' : Engine.TYPES.map(t=>`<button class="ghost addt" data-t="${t}">${t}</button>`).join('')}</div>
    <div class="row"><button class="ghost" id="delObj" ${team.canEdit===false?'disabled':''}>Delete</button><input id="thumbUrl" placeholder="Thumbnail data URL or assets/ path" style="flex:1"/><button class="btn" id="saveThumb">Set Logo</button><button class="btn" id="saveEd" ${team.canEdit===false?'disabled':''}>Save</button>
      <button class="ghost" id="testMp">TEST SERVER</button><button class="btn" id="pub" ${team.canPublish===false?'disabled':''}>Publish</button></div>
    <div class="card" style="margin-top:12px">
      <h3>Team Studio</h3>
      <p class="muted">Invite collaborators by username. Roles are enforced on the server.</p>
      ${team.canManage ? `<div class="row"><input id="collabUser" placeholder="@username" style="flex:1"/>
        <select id="collabRole"><option value="editor">Editor</option><option value="viewer">Viewer</option></select>
        <button type="button" class="btn" id="collabInviteBtn">Invite</button></div>
        <p id="collabMsg" class="muted"></p>` : '<p class="muted">Only the owner can manage members.</p>'}
      <div class="list" style="margin-top:8px">${membersHtml}</div>
      <h4>Activity</h4>
      <div class="list">${actHtml}</div>
    </div>
    <div class="card" style="margin-top:12px"><h3>Monetization — Game Passes</h3>
      <p class="muted">Players pay Kavx. You earn 60%, Kavryon 40%.</p>
      <input id="passName" placeholder="Pass name"/><input id="passPrice" type="number" min="1" placeholder="Price Kavx"/>
      <input id="passDesc" placeholder="Description"/>
      <button class="btn" id="createPass">Create Pass</button>
      <div id="passList" class="list muted"></div>
    </div>
    <div class="card" style="margin-top:12px">
      <h3>AI Studio</h3>
      <p class="muted">Connect your own AI API keys. Keys are encrypted on the server and never returned to the client.</p>
      <div id="aiProvList" class="list muted">Loading…</div>
      <div class="row" style="flex-wrap:wrap;gap:8px;margin-top:8px">
        <select id="aiProvType"><option value="openai">OpenAI</option><option value="gemini">Gemini</option><option value="grok">Grok</option><option value="claude">Claude</option><option value="deepseek">DeepSeek</option><option value="custom">Custom OpenAI-compatible</option></select>
        <input id="aiKey" type="password" placeholder="API key" autocomplete="off" style="flex:1;min-width:120px"/>
        <input id="aiBase" placeholder="Custom base URL (https)" style="display:none;flex:1"/>
        <button class="btn" id="aiConnect">Connect</button>
      </div>
      <p id="aiProvMsg" class="muted"></p>
    </div>
    <textarea id="scr" placeholder="onPlayerJoin: say hello">${(data.scripts||[]).map(s=>s.event+':\n'+s.source).join('\n\n')}</textarea>
    <p id="emsg"></p>`;
}

async function playView(payload) {
  const isTouch = (navigator.maxTouchPoints > 0) || window.matchMedia('(pointer: coarse)').matches;
  return `<div class="play-wrap${isTouch ? ' touch' : ''}" id="playRoot">
    <button type="button" class="kav-menu-btn" id="kavMenuBtn" aria-label="Kavryon menu" title="Kavryon">
      <img src="assets/kavryon-menu-icon.svg" alt="" class="kav-menu-icon" onerror="this.style.display='none'" />
      <span class="brand" style="font-size:11px;letter-spacing:.08em">K</span>
    </button>
    <div id="kavMenu" class="kav-menu" hidden>
      <div class="kav-menu-panel">
        <h3>Kavryon</h3>
        <button type="button" class="kav-item" data-act="resume">Resume</button>
        <button type="button" class="kav-item" data-act="players">Players</button>
        <button type="button" class="kav-item" data-act="invite">Invite Friends</button>
        <button type="button" class="kav-item" data-act="settings">Settings</button>
        <button type="button" class="kav-item" data-act="hud">Set Buttons (HUD)</button>
        <button type="button" class="kav-item" data-act="help">Help / Controls</button>
        <button type="button" class="kav-item" data-act="report">Report</button>
        <button type="button" class="kav-item danger" data-act="leave">Leave Game</button>
      </div>
      <div id="kavSub" class="kav-sub" hidden></div>
    </div>
    <p class="muted" id="netstat">Connecting…</p>
    <canvas id="stage" width="640" height="360"></canvas>
    <div class="hud-layer" id="hudLayer" aria-hidden="false">
      <div class="hud-ctrl" id="hudStick" data-hud="stick">
        <div class="hud-stick-base"><div class="hud-stick-knob" id="hudKnob"></div></div>
      </div>
      <div class="hud-ctrl hud-btn" id="hudJump" data-hud="jump">JUMP</div>
      <div class="hud-ctrl hud-btn" id="hudAttack" data-hud="attack">ATK</div>
      <div class="hud-ctrl hud-btn" id="hudInteract" data-hud="interact">USE</div>
    </div>
  </div>`;
}

function loadHudLayout() {
  try {
    const raw = localStorage.getItem('kav_hud_v1');
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return {
    stick: { x: 16, y: null, bottom: 24, scale: 1 },
    jump: { x: null, right: 24, y: null, bottom: 100, scale: 1 },
    attack: { x: null, right: 96, y: null, bottom: 36, scale: 1 },
    interact: { x: null, right: 24, y: null, bottom: 36, scale: 1 },
    visible: true
  };
}
function saveHudLayout(layout) {
  localStorage.setItem('kav_hud_v1', JSON.stringify(layout));
}
function applyHudLayout(layout) {
  const map = {
    stick: document.getElementById('hudStick'),
    jump: document.getElementById('hudJump'),
    attack: document.getElementById('hudAttack'),
    interact: document.getElementById('hudInteract')
  };
  const layer = document.getElementById('hudLayer');
  if (layer) layer.style.display = layout.visible === false ? 'none' : '';
  for (const [key, el] of Object.entries(map)) {
    if (!el || !layout[key]) continue;
    const L = layout[key];
    el.style.left = L.x != null ? L.x + 'px' : '';
    el.style.right = L.right != null ? L.right + 'px' : '';
    el.style.top = L.y != null ? L.y + 'px' : '';
    el.style.bottom = L.bottom != null ? L.bottom + 'px' : '';
    const sc = L.scale || 1;
    el.style.transform = 'scale(' + sc + ')';
    el.style.transformOrigin = 'center center';
  }
}


async function dashView() {
  const d = await Api.dash();
  let an = null;
  try { an = await Api.analytics(); } catch(_){}

  return `<h2>Creator Dashboard</h2>${an?`<div class=\"grid\"><div class=\"card\">Plays<br><b>${an.totalPlays||0}</b></div><div class=\"card\">Likes<br><b>${an.totalLikes||0}</b></div><div class=\"card\">Favorites<br><b>${an.favorites||0}</b></div><div class=\"card\">Kavx earned<br><b>${an.kavxEarned||0}</b></div></div>`:''}
    <div class="grid">
      <div class="card">Games<br><b>${d.totals.games}</b></div>
      <div class="card">Plays<br><b>${d.totals.plays}</b></div>
      <div class="card">Likes<br><b>${d.totals.likes}</b></div>
      <div class="card">Earned today<br><b>${d.earnedToday||0}</b></div>
    </div>
    <p class="muted">${d.note}</p>
    <div class="list">${d.games.map(g=>`<div class="card row"><b>${esc(g.name)}</b><button class="ghost editg" data-id="${g.id}">Open</button></div>`).join('')}</div>`;
}

function bindShell() {
  document.querySelectorAll('.nav button').forEach((b) => b.onclick = () => { state.tab = b.dataset.tab; go(b.dataset.tab, null, true); });

  // Videos
  document.querySelectorAll('[data-vid]').forEach((b) => b.onclick = () => go('video', b.dataset.vid));
  const goMy = document.getElementById('goMyVideos');
  if (goMy) goMy.onclick = () => go('myVideos', null);
  const backVids = document.getElementById('backVids');
  if (backVids) backVids.onclick = () => go('videos', null, false);
  const openVidGame = document.getElementById('openVidGame');
  if (openVidGame) openVidGame.onclick = () => go('game', openVidGame.dataset.gid);
  const reportVid = document.getElementById('reportVid');
  if (reportVid) reportVid.onclick = async () => {
    try { await Api.reportVideo(state.payload, 'inappropriate'); toast('Report submitted', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };
  const saveVidSettings = document.getElementById('saveVidSettings');
  if (saveVidSettings) saveVidSettings.onclick = async () => {
    try {
      await Api.setVideoSettings({
        videosEnabled: document.getElementById('vidEnabled').checked,
        defaultVisibility: document.getElementById('vidDefaultVis').value
      });
      document.getElementById('vidSetMsg').textContent = 'Saved';
      toast('Video settings saved', 'ok');
    } catch (e) { document.getElementById('vidSetMsg').textContent = e.message; }
  };
  const vidUpload = document.getElementById('vidUpload');
  if (vidUpload) vidUpload.onclick = async () => {
    const f = document.getElementById('vidFile').files[0];
    const msg = document.getElementById('vidMsg');
    const prog = document.getElementById('vidProg');
    if (!f) { msg.textContent = 'Choose a file'; return; }
    const fd = new FormData();
    fd.append('file', f);
    fd.append('title', document.getElementById('vidTitle').value || f.name);
    fd.append('description', document.getElementById('vidDesc').value || '');
    fd.append('visibility', document.getElementById('vidVis').value);
    const gid = document.getElementById('vidGameId').value.trim();
    if (gid) fd.append('gameId', gid);
    msg.textContent = 'Uploading…';
    try {
      await Api.uploadVideo(fd, (p) => { prog.textContent = p + '%'; });
      msg.textContent = 'Uploaded';
      toast('Clip uploaded', 'ok');
      go('myVideos', null, false);
    } catch (e) {
      msg.textContent = e.message || 'Upload failed';
      toast(e.message, 'err');
    }
  };
  document.querySelectorAll('.vid-open').forEach((b) => b.onclick = () => go('video', b.dataset.id));
  document.querySelectorAll('.vid-del').forEach((b) => b.onclick = async () => {
    if (!confirm('Delete this clip?')) return;
    try { await Api.deleteVideo(b.dataset.id); toast('Deleted', 'ok'); go('myVideos', null, false); }
    catch (e) { toast(e.message, 'err'); }
  });

  const store = document.getElementById('openStore');
  if (store) store.onclick = () => go('store');
  const q = document.getElementById('q');
  if (q) q.onchange = async () => {
    const v = q.value.trim();
    if (v.startsWith('@')) go('friends', { q: v });
    else if (v) {
      try {
        const r = await Api.searchGames(v);
        state.view = 'discover';
        state.payload = { search: r.games, q: v };
        render();
      } catch (e) { alert(e.message); }
    } else go('discover');
  };
  document.querySelectorAll('.game').forEach((el) => el.onclick = () => go('game', el.dataset.id));
  document.querySelectorAll('[data-cat]').forEach((b) => b.onclick = () => go('discover', { category: b.dataset.cat || undefined }, false));
  const buyDev = document.getElementById('buyDev');
  if (buyDev) buyDev.onclick = async () => {
    try { const r = await Api.devMode(); state.user.developer_mode = true; state.user.kavx = r.balance; render(); }
    catch (e) { document.getElementById('cmsg').textContent = e.message; }
  };
  const newGame = document.getElementById('newGame');
  if (newGame) newGame.onclick = () => document.getElementById('newForm').hidden = false;
  const saveNew = document.getElementById('saveNew');
  if (saveNew) saveNew.onclick = async () => {
    const g = await Api.createGame({ name: $('#gn').value, description: $('#gd').value, category: $('#gc').value, template: $('#gt').value, maxPlayers: $('#gm').value, dimension: ($('#gdim')&&$('#gdim').value)||'2d' });
    go('editor', g.game.id);
  };
  const toDash = document.getElementById('toDash');
  if (toDash) toDash.onclick = () => go('dash');
  document.querySelectorAll('.editg').forEach((b) => b.onclick = () => go('editor', b.dataset.id));
  const fsearch = document.getElementById('fsearch');
  if (fsearch) fsearch.onclick = async () => {
    const users = (await Api.searchUsers(document.getElementById('fs').value)).users;
    document.getElementById('fresults').innerHTML = users.map(u => `<div class="card row"><b>${esc(u.username)}</b><button class="btn addf" data-u="${esc(u.username)}">ADD FRIEND</button></div>`).join('');
    document.querySelectorAll('.addf').forEach((b) => b.onclick = async () => { await Api.addFriend(b.dataset.u); b.textContent = 'Friend Request Sent'; });
  };
  document.querySelectorAll('.acc').forEach((b) => b.onclick = async () => { await Api.accept(b.dataset.id); render(); });
  document.querySelectorAll('.dec').forEach((b) => b.onclick = async () => { await Api.decline(b.dataset.id); render(); });
  document.querySelectorAll('.buy').forEach((b) => b.onclick = () => buyPack(b.dataset.id));
  document.querySelectorAll('.bd-buy').forEach((b) => b.onclick = async () => {
    const msg = document.getElementById('smsg');
    try {
      if (msg) msg.textContent = 'Creating order…';
      const r = await Api.bdCreateOrder(b.dataset.id);
      if (r.gatewayUrl) {
        if (msg) msg.textContent = 'Redirecting to payment gateway…';
        window.location.href = r.gatewayUrl;
      } else if (msg) msg.textContent = 'No gateway URL returned';
    } catch (e) {
      if (msg) msg.textContent = e.message || 'Payment unavailable';
      toast(e.message || 'Payment unavailable', 'err');
    }
  });
  const openWallet = document.getElementById('openWallet');
  if (openWallet) openWallet.onclick = () => go('wallet');
  const logout = document.getElementById('logout');
  if (logout) logout.onclick = async () => {
    try { await Api.logout(); } catch (_) {}
    Api.clearAuth();
    state.user = null;
    go('auth', null, false);
  };
  const saveAv = document.getElementById('saveAv');
  if (saveAv) saveAv.onclick = async () => {
    const body = {};
    document.querySelectorAll('[data-av]').forEach((i) => body[i.dataset.av] = i.value);
    const r = await Api.profile(body);
    state.user = r.user;
    render();
  };
  const inv = document.getElementById('inv');
  if (inv) Api.inventory().then((r) => { inv.innerHTML = r.items.map((i) => `<div class="card">${esc(i.name)} × ${i.qty}</div>`).join('') || empty(); });
  const notifBox = document.getElementById('notifBox');
  if (notifBox) Api.notifications().then(r => {
    notifBox.innerHTML = (r.notifications||[]).map(n => {
      let extra = '';
      try {
        const d = typeof n.data_json === 'string' ? JSON.parse(n.data_json||'{}') : (n.data_json||{});
        if (n.type === 'GAME_INVITE' && d.inviteId) {
          extra = `<div class="row"><button class="btn invAcc" data-id="${esc(d.inviteId)}">JOIN</button>
            <button class="ghost invDec" data-id="${esc(d.inviteId)}">DECLINE</button></div>`;
        }
      } catch(_){}
      return `<div class="card"><b>${esc(n.title)}</b><div class="muted">${esc(n.body)}</div>${extra}</div>`;
    }).join('') || empty();
    notifBox.querySelectorAll('.invAcc').forEach((b) => b.onclick = async () => {
      try {
        const r = await Api.respondInvite(b.dataset.id, 'accept');
        if (r.gameId && r.ticket) {
          const g = await Api.game(r.gameId);
          go('play', { gameId: r.gameId, serverId: r.serverId, name: r.gameName, objects: g.objects, ticket: r.ticket, maxPlayers: g.game.max_players });
        } else if (r.gameId) {
          const play = await Api.play(r.gameId, r.serverId);
          const g = await Api.game(r.gameId);
          go('play', { gameId: r.gameId, serverId: play.serverId || r.serverId, name: r.gameName, objects: g.objects, ticket: play.ticket, maxPlayers: g.game.max_players });
        }
      } catch(e) { toast(e.message); }
    });
    notifBox.querySelectorAll('.invDec').forEach((b) => b.onclick = async () => {
      try { await Api.respondInvite(b.dataset.id, 'decline'); toast('Declined'); render(); } catch(e) { toast(e.message); }
    });
  }).catch(() => { notifBox.textContent = ''; });
  const runOwner = document.getElementById('runOwner');
  if (runOwner) runOwner.onclick = async () => {
    try {
      const r = await Api.ownerCommand(document.getElementById('ownerCmd').value);
      document.getElementById('ownerMsg').textContent = JSON.stringify(r.result || r);
      state.user = (await Api.me()).user;
    } catch (e) { document.getElementById('ownerMsg').textContent = e.message; }
  };
  if (state.user && (state.user.role === 'admin' || state.user.isOwner) && document.getElementById('adminBox')) {
    Api.adminOverview().then((o) => { document.getElementById('adminBox').textContent = JSON.stringify(o, null, 2); }).catch(() => {});
  }
  const backBtn = document.getElementById('backBtn');
  if (backBtn) backBtn.onclick = () => back();
  document.querySelectorAll('.playFirst').forEach((b) => b.onclick = () => startPlay(b.dataset.id));
  document.querySelectorAll('.joinS').forEach((b) => b.onclick = () => startPlay(b.dataset.gid, b.dataset.sid));
  document.querySelectorAll('.like').forEach((b) => b.onclick = () => Api.like(b.dataset.id));
  document.querySelectorAll('.fav').forEach((b) => b.onclick = async () => { try { const r = await Api.fav(b.dataset.id); b.textContent = (r.favorited?'Favorited':'Favorite'); toast(r.favorited?'Favorited':'Removed'); } catch(e){ toast(e.message);} });
  document.querySelectorAll('.createPriv').forEach((b) => b.onclick = async () => {
    const code = prompt('Access code (optional)') || '';
    try {
      const r = await Api.privateServer(b.dataset.id, { name: 'Private', maxPlayers: 8, accessCode: code || null });
      toast('Private server: ' + r.id);
    } catch(e) { toast(e.message); }
  });
  document.querySelectorAll('.rpt').forEach((b) => b.onclick = () => Api.report({ targetType: 'game', targetId: b.dataset.id, reason: 'Other', details: '' }));
  if (state.view === 'editor') bindEditor();
  
  document.querySelectorAll('.buyAsset').forEach((b) => b.onclick = async () => {
    try {
      const r = await Api.buyAsset(b.dataset.id, { idempotencyKey: 'buy_'+b.dataset.id+'_'+Date.now() });
      toast(r.duplicate ? 'Already owned' : (r.price ? 'Purchased' : 'Added'));
      if (r.balance != null && state.user) state.user.kavx = r.balance;
    } catch(e) { toast(e.message); }
  });
  const apub = document.getElementById('apub');
  if (apub) apub.onclick = async () => {
    try {
      await Api.publishAsset({ name: document.getElementById('aname').value, type: document.getElementById('atype').value, priceKavx: Number(document.getElementById('aprice').value)||0, data: {} });
      toast('Asset submitted'); go('market');
    } catch(e) { toast(e.message); }
  };
  const asave = document.getElementById('asave');
  if (asave) asave.onclick = async () => {
    try {
      await Api.setAvatar({ body: document.getElementById('abody').value, hair: document.getElementById('ahair').value, outfit: document.getElementById('aoutfit').value, accessory: document.getElementById('aacc').value });
      toast('Avatar saved');
    } catch(e) { toast(e.message); }
  };

  const gcreate = document.getElementById('gcreate');
  if (gcreate) gcreate.onclick = async () => {
    try { await Api.createGroup({ name: document.getElementById('gname').value }); toast('Group created'); go('groups'); } catch(e) { toast(e.message); }
  };
  document.querySelectorAll('.buyPass').forEach((b) => b.onclick = async () => {
    try {
      const r = await Api.buyPass(b.dataset.id, { idempotencyKey: 'pass_'+b.dataset.id+'_'+Date.now() });
      toast(r.duplicate ? 'Already owned' : ('Purchased · creator +'+r.creatorShare+' platform +'+r.platformShare));
      if (r.balance != null && state.user) state.user.kavx = r.balance;
    } catch(e) { toast(e.message); }
  });
  const createPassBtn = document.getElementById('createPass');
  if (createPassBtn && state.edit && state.edit.game) {
    const refreshPasses = async () => {
      const box = document.getElementById('passList');
      if (!box) return;
      try {
        const r = await Api.listPasses(state.edit.game.id);
        box.innerHTML = (r.passes||[]).map(p => `<div class="card"><b>${esc(p.name)}</b> · ${p.priceKavx} Kavx ${p.active?'':' (off)'}</div>`).join('') || '<p class="muted">No passes yet</p>';
      } catch(e) { box.textContent = e.message; }
    };
    refreshPasses();
    createPassBtn.onclick = async () => {
      try {
        await Api.createPass(state.edit.game.id, {
          name: document.getElementById('passName').value,
          priceKavx: Number(document.getElementById('passPrice').value),
          description: document.getElementById('passDesc').value
        });
        toast('Pass created');
        refreshPasses();
      } catch(e) { toast(e.message); }
    };
  }
  if (state.view === 'play') bindPlay();
  document.querySelectorAll('.giftBtn').forEach((b) => b.onclick = () => openGiftModal(b.dataset.u));
  document.querySelectorAll('.joinFriend').forEach((b) => b.onclick = () => startPlay(b.dataset.gid, b.dataset.sid || undefined));
  // Leave handled via Kavryon menu
}

async function buyPack(productId) {
  const msg = document.getElementById('smsg');
  try {
    const intent = await Api.intent(productId);
    // Production: Google Play Billing via native bridge (never trust client amounts)
    if (intent.mode === 'play_billing' || intent.mode !== 'sandbox') {
      if (typeof KavryonBilling !== 'undefined' && KavryonBilling.isReady && KavryonBilling.isReady()) {
        msg.textContent = 'Opening Google Play…';
        window.__kavryonPurchaseResult = async (result) => {
          try {
            if (!result || result.error) {
              msg.textContent = 'Purchase failed' + (result && result.error ? (': ' + result.error) : '');
              return;
            }
            if (result.responseCode === 1) { msg.textContent = 'Purchase cancelled'; return; }
            if (result.responseCode != null && result.responseCode !== 0) {
              msg.textContent = 'Billing error ' + result.responseCode;
              return;
            }
            const purchases = result.purchases || [];
            if (!purchases.length) { msg.textContent = 'No purchase returned'; return; }
            for (const p of purchases) {
              // Google Play can return pending purchases; only PURCHASED may be verified/granted.
              if (p.purchaseState !== 1) {
                msg.textContent = p.purchaseState === 2
                  ? 'Purchase pending; Kavx will be added after Google Play confirms it.'
                  : 'Purchase is not completed.';
                continue;
              }
              const pid = (p.products && p.products[0]) || productId;
              if (!pid || !p.purchaseToken) {
                msg.textContent = 'Purchase response was incomplete.';
                continue;
              }
              const r = await Api.complete({
                productId: pid,
                purchaseToken: p.purchaseToken,
                packageName: 'com.kavryon.platform'
              });
              if (r && r.balance != null && state.user) state.user.kavx = r.balance;
              msg.textContent = r.duplicate ? 'Already processed' : ('Granted ' + (r.kavxGranted || '') + ' Kavx (verified)');
              if (typeof KavryonBilling.acknowledgePurchase === 'function' && p.purchaseToken) {
                KavryonBilling.acknowledgePurchase(p.purchaseToken);
              }
            }
            render();
          } catch (e) {
            msg.textContent = e.message || 'Verification failed';
          }
        };
        KavryonBilling.launchPurchase(productId);
        return;
      }
      msg.textContent = 'Google Play Billing is not available. Install the Play Store build of Kavryon to purchase Kavx.';
      return;
    }
    // Sandbox ONLY when server explicitly enables SANDBOX_PAYMENTS (dev/test)
    if (intent.mode === 'sandbox') {
      const ok = confirm('DEV sandbox only: simulate billing for ' + productId + '? No real charge.');
      if (!ok) { msg.textContent = 'Cancelled'; return; }
      const r = await Api.complete({ sandboxToken: intent.sandboxToken, productId });
      state.user.kavx = r.balance;
      msg.textContent = r.duplicate ? 'Already processed' : ('Granted ' + r.kavxGranted + ' Kavx (sandbox)');
      render();
    }
  } catch (e) { msg.textContent = e.message; }
}

async function startPlay(gameId, serverId) {
  const g = await Api.game(gameId);
  const r = await Api.play(gameId, serverId);
  go('play', { gameId, serverId: r.serverId, name: g.game.name, objects: g.objects, ticket: r.ticket });
}

function bindEditor() {
  const canvas = document.getElementById('stage');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const fit = () => {
    Engine.drawWorld(ctx, canvas.width, canvas.height, state.edit.objects, [], state.edit.sel);
  };
  fit();
  canvas.ontouchstart = canvas.onmousedown = (ev) => {
    const r = canvas.getBoundingClientRect();
    const x = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left) * canvas.width / r.width;
    const y = ((ev.touches ? ev.touches[0].clientY : ev.clientY) - r.top) * canvas.height / r.height;
    state.edit.sel = Engine.hit(state.edit.objects, x, y);
    state.edit.drag = true;
    fit();
  };
  const move = (ev) => {
    if (!state.edit.drag || !state.edit.sel) return;
    const r = canvas.getBoundingClientRect();
    const x = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left) * canvas.width / r.width;
    const y = ((ev.touches ? ev.touches[0].clientY : ev.clientY) - r.top) * canvas.height / r.height;
    state.edit.sel.x = x; state.edit.sel.y = y; fit();
  };
  canvas.ontouchmove = canvas.onmousemove = move;
  canvas.ontouchend = canvas.onmouseup = () => { state.edit.drag = false; };
  document.querySelectorAll('.addt').forEach((b) => b.onclick = () => {
    state.edit.objects.push({ id: crypto.randomUUID(), type: b.dataset.t, name: b.dataset.t, x: 200, y: 180, rotation: 0, scale_x: 1, scale_y: 1, collision: 1, visibility: 1 });
    fit();
  });
  document.getElementById('delObj').onclick = () => {
    if (!state.edit.sel) return;
    state.edit.objects = state.edit.objects.filter((o) => o.id !== state.edit.sel.id);
    state.edit.sel = null; fit();
  };
  const st = document.getElementById('saveThumb');
  if (st) st.onclick = async () => {
    try {
      await Api.updateGame(state.edit.game.id, { thumbnail: document.getElementById('thumbUrl').value });
      toast('Thumbnail updated');
    } catch(e) { toast(e.message); }
  };
  
  async function refreshAiProv() {
    const box = document.getElementById('aiProvList');
    if (!box) return;
    try {
      const r = await Api.aiProviders();
      box.innerHTML = (r.providers||[]).map(pr => `<div class="card row"><div><b>${esc(pr.label||pr.provider)}</b> · ${esc(pr.model||'')} ${pr.isDefault?'· default':''}<div class="muted">${pr.lastTestOk===true?'Connected':pr.lastTestOk===false?'Failed':'Not tested'}</div></div>
        <div class="row"><button class="ghost aiTest" data-id="${pr.id}">Test</button>
        <button class="ghost aiDef" data-id="${pr.id}">Default</button>
        <button class="ghost aiDel" data-id="${pr.id}">Remove</button></div></div>`).join('') || '<p class="muted">No providers connected</p>';
      box.querySelectorAll('.aiTest').forEach(b => b.onclick = async () => { try { const r = await Api.aiProviderTest(b.dataset.id); toast(r.message|| (r.ok?'OK':'Failed')); refreshAiProv(); } catch(e){ toast(e.message);} });
      box.querySelectorAll('.aiDef').forEach(b => b.onclick = async () => { try { await Api.aiProviderDefault(b.dataset.id); refreshAiProv(); } catch(e){ toast(e.message);} });
      box.querySelectorAll('.aiDel').forEach(b => b.onclick = async () => { try { await Api.aiProviderRemove(b.dataset.id); refreshAiProv(); } catch(e){ toast(e.message);} });
    } catch(e) { box.innerHTML = '<p class="err">'+esc(e.message)+'</p>'; }
  }
  refreshAiProv();
  const aiType = document.getElementById('aiProvType');
  if (aiType) aiType.onchange = () => { const b=document.getElementById('aiBase'); if(b) b.style.display = aiType.value==='custom'?'block':'none'; };
  const aiConn = document.getElementById('aiConnect');
  if (aiConn) aiConn.onclick = async () => {
    const msg = document.getElementById('aiProvMsg');
    try {
      await Api.aiProviderAdd({ provider: document.getElementById('aiProvType').value, apiKey: document.getElementById('aiKey').value, baseUrl: document.getElementById('aiBase')&&document.getElementById('aiBase').value });
      document.getElementById('aiKey').value = '';
      if (msg) msg.textContent = 'Provider connected (key stored encrypted; not shown again).';
      refreshAiProv();
    } catch(e) { if(msg) msg.textContent = e.message; }
  };
  document.getElementById('saveEd').onclick = async () => {
    await Api.saveObjects(state.edit.game.id, state.edit.objects);
    const raw = document.getElementById('scr').value;
    const scripts = [];
    raw.split(/\n(?=on[A-Z])/).forEach((block) => {
      const i = block.indexOf(':');
      if (i > 0) scripts.push({ event: block.slice(0, i).trim(), source: block.slice(i + 1).trim() });
    });
    await Api.saveScripts(state.edit.game.id, scripts);
    document.getElementById('emsg').textContent = 'Saved';
  };
  const aiBtn = document.getElementById('aiBuild');
  if (aiBtn) aiBtn.onclick = async () => {
    const prompt = (document.getElementById('aiPrompt')||{}).value || '';
    if (!prompt.trim()) return toast('Describe the game to build');
    try {
      toast('AI building…');
      const r = await Api.aiBuild({ gameId: state.edit.game.id, prompt, dimension: state.edit.dimension || '2d' });
      if (r.definition) {
        state.edit.objects = (r.definition.objects||[]).map(o=>({id:o.id,type:o.type,name:o.name||o.type,x:o.x,y:o.y,scale_x:(o.w||36)/36,scale_y:(o.h||20)/20,rotation:o.rotation||0,collision:o.collision!==false,props:o.props||{}}));
        state.edit.dimension = r.definition.dimension || '2d';
        toast('AI build done: ' + (r.plan&&r.plan.summary||'ok'));
        go('editor', state.edit);
      } else toast('AI build finished');
    } catch(e) { toast(e.message); }
  };
  const pubStatus = document.getElementById('pubStatus');
  const setPub = (s) => { if (pubStatus) pubStatus.textContent = s; };
  const valBtn = document.getElementById('validatePub');
  if (valBtn) valBtn.onclick = async () => {
    try {
      setPub('Validating…');
      const v = await Api.validateGame(state.edit.game.id);
      if (v.ok) setPub('Validation passed' + (v.warnings&&v.warnings.length ? ' (warnings: '+v.warnings.join('; ')+')' : ''));
      else setPub('Errors: ' + (v.errors||[]).join('; '));
    } catch(e) { setPub(e.message); }
  };
  const pubBtn = document.getElementById('publishGame');
  if (pubBtn) pubBtn.onclick = async () => {
    try {
      setPub('Publishing…');
      let r;
      try { r = await Api.publish(state.edit.game.id, {}); }
      catch (e) {
        if (String(e.message).includes('Warnings') || e.message.includes('confirm')) {
          if (confirm('Publish with warnings?')) r = await Api.publish(state.edit.game.id, { confirmWarnings: true });
          else { setPub('Publish cancelled'); return; }
        } else throw e;
      }
      state.edit.game = r.game;
      setPub('Published v' + (r.version||r.game.version) + ' — live on Discover');
      toast('Published — appears in New & Just Published');
    } catch(e) { setPub(e.message); toast(e.message); }
  };
  const unBtn = document.getElementById('unpublishGame');
  if (unBtn) unBtn.onclick = async () => {
    try {
      const r = await Api.unpublish(state.edit.game.id);
      state.edit.game = r.game;
      setPub('Unpublished (draft)');
    } catch(e) { setPub(e.message); }
  };
  document.getElementById('testMp').onclick = async () => {
    const t = await Api.testServer(state.edit.game.id);
    go('play', { gameId: state.edit.game.id, serverId: t.server.id, name: 'TEST SERVER', objects: state.edit.objects, ticket: t.ticket });
  };
  document.getElementById('pub').onclick = async () => {
    try { await Api.publish(state.edit.game.id); document.getElementById('emsg').textContent = 'Published'; }
    catch (e) { document.getElementById('emsg').textContent = e.message; }
  };
}



async function groupsView() {
  const r = await Api.groups();
  return `<h2>Groups</h2>
    <div class="list">${(r.groups||[]).map(g=>`<div class="card"><b>${esc(g.name)}</b><div class="muted">${esc(g.role||'')}</div></div>`).join('')||empty()}</div>
    <input id="gname" placeholder="Group name"/><button class="btn" id="gcreate">Create Group</button>`;
}
async function marketView() {
  const r = await Api.marketplace({});
  return `<h2>Creator Marketplace</h2>
    <p class="muted">Free and Kavx assets from the community. Purchases are server-verified.</p>
    <div class="list">${(r.assets||[]).map(a => `
      <div class="card row"><div><b>${esc(a.name)}</b><div class="muted">${esc(a.type)} · @${esc(a.creator)} · ${a.price_kavx||0} Kavx</div></div>
      <button class="btn buyAsset" data-id="${a.id}" data-price="${a.price_kavx||0}">${a.price_kavx?('Buy '+a.price_kavx):'Get free'}</button></div>`).join('')||empty()}</div>
    <h3>Publish asset</h3>
    <input id="aname" placeholder="Asset name"/><select id="atype"><option>item</option><option>template</option><option>ui</option><option>npc</option><option>weapon</option></select>
    <input id="aprice" type="number" min="0" placeholder="Kavx price (0=free)"/>
    <button class="btn" id="apub">Publish</button><p id="amsg" class="muted"></p>`;
}
async function avatarView() {
  const r = await Api.avatar();
  const a = r.avatar||{};
  return `<h2>Avatar</h2>
    <div class="card">
      <label>Body <select id="abody"><option>core</option><option>tall</option><option>compact</option></select></label>
      <label>Hair <select id="ahair"><option>short</option><option>long</option><option>none</option></select></label>
      <label>Outfit <select id="aoutfit"><option>trailcoat</option><option>runner</option><option>explorer</option></select></label>
      <label>Accessory <select id="aacc"><option>none</option><option>prism_pin</option><option>goggles</option></select></label>
      <button class="btn" id="asave">Save Avatar</button>
    </div>`;
}
function bindPlay() {
  const canvas = document.getElementById('stage');
  const stat = document.getElementById('netstat');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!state.payload.ticket) {
    if (stat) stat.textContent = 'Missing connection ticket';
    return;
  }
  // Derive WS from API base (Android WebView must not use location.host file/appassets)
  function wsUrl(path) {
    const base = (typeof window !== 'undefined' && window.KAVRYON_API_BASE) ? String(window.KAVRYON_API_BASE).replace(/\/$/, '') : '';
    if (base) {
      try {
        const u = new URL(base);
        const wsp = u.protocol === 'https:' ? 'wss:' : 'ws:';
        return wsp + '//' + u.host + path;
      } catch (_) {}
    }
    const proto = location.protocol === 'https:' ? 'wss:' : (location.protocol === 'http:' ? 'ws:' : 'ws:');
    const host = (location.host && location.protocol !== 'file:') ? location.host : '127.0.0.1:8080';
    return proto + '//' + host + path;
  }
  const qs = `ticket=${encodeURIComponent(state.payload.ticket)}&game=${state.payload.gameId}&server=${state.payload.serverId}`;
  const ws = new WebSocket(wsUrl('/ws') + '?' + qs);
  state.ws = ws;
  let players = [];
  let objects = state.payload.objects || [];
  let keys = { left: false, right: false, jump: false, attack: false, interact: false };
  let seq = 0;
  let menuOpen = false;

  // —— Mobile HUD ——
  let hudLayout = loadHudLayout();
  let hudEdit = false;
  applyHudLayout(hudLayout);
  const playRoot = document.getElementById('playRoot');
  const hudLayer = document.getElementById('hudLayer');

  function setHudEdit(on) {
    hudEdit = on;
    if (playRoot) playRoot.classList.toggle('hud-edit', on);
    if (hudLayer) hudLayer.classList.toggle('force-show', on);
    let ban = document.getElementById('hudEditBan');
    if (on) {
      if (!ban) {
        ban = document.createElement('div');
        ban.id = 'hudEditBan';
        ban.className = 'hud-edit-banner';
        ban.innerHTML = 'Drag buttons to move · pinch not required · <button type="button" class="btn sm" id="hudSave">Save</button> <button type="button" class="btn sm secondary" id="hudReset">Reset</button> <button type="button" class="btn sm ghost" id="hudDone">Done</button>';
        playRoot.appendChild(ban);
        document.getElementById('hudSave').onclick = () => { saveHudLayout(hudLayout); toast('HUD saved', 'ok'); };
        document.getElementById('hudReset').onclick = () => {
          localStorage.removeItem('kav_hud_v1');
          hudLayout = loadHudLayout();
          applyHudLayout(hudLayout);
          toast('HUD reset');
        };
        document.getElementById('hudDone').onclick = () => { setHudEdit(false); setMenu(false); };
      }
      ban.hidden = false;
    } else if (ban) ban.hidden = true;
  }

  // Joystick
  const stick = document.getElementById('hudStick');
  const knob = document.getElementById('hudKnob');
  let stickTouchId = null;
  function stickAt(clientX, clientY) {
    if (!stick) return;
    const base = stick.querySelector('.hud-stick-base') || stick;
    const r = base.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let dx = clientX - cx;
    let dy = clientY - cy;
    const max = r.width * 0.35;
    const mag = Math.sqrt(dx * dx + dy * dy) || 1;
    if (mag > max) { dx = dx / mag * max; dy = dy / mag * max; }
    if (knob) knob.style.transform = `translate(${dx}px,${dy}px)`;
    if (!hudEdit) {
      keys.left = dx < -12;
      keys.right = dx > 12;
    }
  }
  function stickEnd() {
    stickTouchId = null;
    if (knob) knob.style.transform = '';
    keys.left = keys.right = false;
  }
  if (stick) {
    stick.addEventListener('touchstart', (e) => {
      if (hudEdit) return;
      e.preventDefault();
      const t = e.changedTouches[0];
      stickTouchId = t.identifier;
      stickAt(t.clientX, t.clientY);
    }, { passive: false });
    stick.addEventListener('touchmove', (e) => {
      if (hudEdit) return;
      for (const t of e.changedTouches) {
        if (t.identifier === stickTouchId) { e.preventDefault(); stickAt(t.clientX, t.clientY); }
      }
    }, { passive: false });
    stick.addEventListener('touchend', (e) => {
      for (const t of e.changedTouches) if (t.identifier === stickTouchId) stickEnd();
    });
  }
  function bindHudButton(el, keyName) {
    if (!el) return;
    const down = (e) => {
      if (hudEdit) return;
      e.preventDefault();
      keys[keyName] = true;
      el.classList.add('active');
    };
    const up = () => { keys[keyName] = false; el.classList.remove('active'); };
    el.addEventListener('touchstart', down, { passive: false });
    el.addEventListener('touchend', up);
    el.addEventListener('touchcancel', up);
    el.addEventListener('mousedown', down);
    el.addEventListener('mouseup', up);
    el.addEventListener('mouseleave', up);
  }
  bindHudButton(document.getElementById('hudJump'), 'jump');
  bindHudButton(document.getElementById('hudAttack'), 'attack');
  bindHudButton(document.getElementById('hudInteract'), 'interact');

  // Drag to reposition in edit mode
  let dragHud = null;
  function hudPointerDown(e, key) {
    if (!hudEdit) return;
    e.preventDefault();
    const el = document.querySelector('[data-hud="' + key + '"]');
    if (!el) return;
    const pt = e.touches ? e.touches[0] : e;
    const root = playRoot.getBoundingClientRect();
    dragHud = { key, el, ox: pt.clientX - el.getBoundingClientRect().left, oy: pt.clientY - el.getBoundingClientRect().top, root };
  }
  function hudPointerMove(e) {
    if (!dragHud) return;
    const pt = e.touches ? e.touches[0] : e;
    const x = pt.clientX - dragHud.root.left - dragHud.ox;
    const y = pt.clientY - dragHud.root.top - dragHud.oy;
    dragHud.el.style.left = Math.max(0, x) + 'px';
    dragHud.el.style.top = Math.max(0, y) + 'px';
    dragHud.el.style.right = '';
    dragHud.el.style.bottom = '';
    hudLayout[dragHud.key] = { x: Math.max(0, x), y: Math.max(0, y), scale: hudLayout[dragHud.key]?.scale || 1 };
  }
  function hudPointerUp() { dragHud = null; }
  ['stick', 'jump', 'attack', 'interact'].forEach((key) => {
    const el = document.querySelector('[data-hud="' + key + '"]');
    if (!el) return;
    el.addEventListener('touchstart', (e) => hudPointerDown(e, key), { passive: false });
    el.addEventListener('mousedown', (e) => hudPointerDown(e, key));
  });
  window.addEventListener('touchmove', hudPointerMove, { passive: false });
  window.addEventListener('mousemove', hudPointerMove);
  window.addEventListener('touchend', hudPointerUp);
  window.addEventListener('mouseup', hudPointerUp);


  let settings = { graphics: localStorage.getItem('kav_gfx') || 'auto', master: Number(localStorage.getItem('kav_vol') || 1), music: Number(localStorage.getItem('kav_music') || 0.7), sfx: Number(localStorage.getItem('kav_sfx') || 1) };

  const menu = document.getElementById('kavMenu');
  const menuBtn = document.getElementById('kavMenuBtn');
  const sub = document.getElementById('kavSub');

  function setMenu(open) {
    menuOpen = open;
    if (menu) menu.hidden = !open;
    if (sub) { sub.hidden = true; sub.innerHTML = ''; }
    keys.left = keys.right = keys.jump = keys.attack = keys.interact = false;
  }
  function showSub(html) {
    if (!sub) return;
    sub.hidden = false;
    sub.innerHTML = html;
  }

  if (menuBtn) menuBtn.onclick = () => setMenu(!menuOpen);
  if (menu) menu.onclick = (e) => {
    const act = e.target && e.target.dataset && e.target.dataset.act;
    if (!act) return;
    if (act === 'resume') setMenu(false);
    else if (act === 'players') {
      const max = state.payload.maxPlayers || 16;
      showSub(`<h4>Players ${players.length}/${max}</h4><div class="list">${players.map(p =>
        `<div class="card row"><div><b>@${esc(p.username)}</b>${p.team?` · ${esc(p.team)}`:''}${p.spectating?' · spectating':''}</div>
         <button class="ghost pAct" data-u="${esc(p.username)}" data-id="${p.id}">Actions</button></div>`
      ).join('') || '<p class="muted">No players</p>'}</div>`);
      sub.querySelectorAll('.pAct').forEach((b) => b.onclick = () => {
        showSub(`<h4>@${esc(b.dataset.u)}</h4>
          <button class="kav-item" id="addFr">Add Friend</button>
          <button class="kav-item" id="repPl">Report Player</button>
          <button class="kav-item" id="backPl">Back</button>`);
        document.getElementById('backPl').onclick = () => menu.querySelector('[data-act=players]').click();
        document.getElementById('addFr').onclick = async () => {
          try { await Api.addFriend(b.dataset.u); toast('Friend request sent'); } catch (err) { toast(err.message); }
        };
        document.getElementById('repPl').onclick = async () => {
          try { await Api.report({ targetType: 'user', targetId: b.dataset.id, reason: 'In-game', details: '' }); toast('Report submitted'); } catch (err) { toast(err.message); }
        };
      });
    } else if (act === 'invite') {
      showSub('<p class="muted">Loading friends…</p>');
      Api.inviteFriends().then((r) => {
        const list = r.friends || [];
        showSub(`<h4>Invite Friends</h4><div class="list">${list.map((f) => {
          const st = (f.presence && f.presence.status) || 'offline';
          const label = st === 'playing' ? `Playing ${esc((f.presence&&f.presence.game)||'')}` : st;
          return `<div class="card row"><div><b>@${esc(f.username)}</b><div class="muted">${esc(label)}</div></div>
            <button class="btn invF" data-u="${esc(f.username)}">INVITE</button></div>`;
        }).join('') || '<p class="muted">No friends yet</p>'}</div>`);
        sub.querySelectorAll('.invF').forEach((b) => b.onclick = async () => {
          try {
            await Api.sendInvite({ username: b.dataset.u, gameId: state.payload.gameId, serverId: state.payload.serverId });
            toast('Invite sent');
            b.textContent = 'Sent';
            b.disabled = true;
          } catch (err) { toast(err.message); }
        });
      }).catch((err) => showSub(`<p class="err">${esc(err.message)}</p>`));
    } else if (act === 'hud') {
      setMenu(false);
      setHudEdit(true);
    } else if (act === 'settings') {
      showSub(`<h4>Settings</h4>
        <label>Graphics <select id="setGfx"><option value="auto">Auto</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
        <label>Master <input type="range" id="setVol" min="0" max="1" step="0.05" value="${settings.master}"/></label>
        <label>Music <input type="range" id="setMusic" min="0" max="1" step="0.05" value="${settings.music}"/></label>
        <label>SFX <input type="range" id="setSfx" min="0" max="1" step="0.05" value="${settings.sfx}"/></label>
        <button class="btn" id="saveSet">Save</button>`);
      const gsel = document.getElementById('setGfx');
      if (gsel) gsel.value = settings.graphics;
      document.getElementById('saveSet').onclick = () => {
        settings.graphics = document.getElementById('setGfx').value;
        settings.master = Number(document.getElementById('setVol').value);
        settings.music = Number(document.getElementById('setMusic').value);
        settings.sfx = Number(document.getElementById('setSfx').value);
        localStorage.setItem('kav_gfx', settings.graphics);
        try { if (typeof Engine3D !== 'undefined' && Engine3D.setQuality) Engine3D.setQuality(settings.graphics); } catch(_){}
        localStorage.setItem('kav_vol', String(settings.master));
        localStorage.setItem('kav_music', String(settings.music));
        localStorage.setItem('kav_sfx', String(settings.sfx));
        toast('Settings saved');
        setMenu(false);
      };
    } else if (act === 'help') {
      showSub(`<h4>Help / Controls</h4>
        <p>Move: Arrow keys / WASD / touch left-right</p>
        <p>Jump: Space / W / touch top</p>
        <p>Attack: J</p>
        <p>Interact: E</p>
        <p>Menu: Kavryon icon (top-left)</p>`);
    } else if (act === 'report') {
      showSub(`<h4>Report</h4>
        <button class="kav-item" id="repGame">Report Game</button>
        <button class="kav-item" id="repClose">Back</button>`);
      document.getElementById('repClose').onclick = () => setMenu(true);
      document.getElementById('repGame').onclick = async () => {
        try {
          await Api.report({ targetType: 'game', targetId: state.payload.gameId, reason: 'In-game', details: '' });
          toast('Report submitted');
          setMenu(false);
        } catch (err) { toast(err.message); }
      };
    } else if (act === 'leave') {
      showSub(`<h4>Leave this game?</h4>
        <div class="row"><button class="btn" id="stayG">STAY</button><button class="btn danger" id="leaveG">LEAVE</button></div>`);
      document.getElementById('stayG').onclick = () => setMenu(false);
      document.getElementById('leaveG').onclick = () => {
        try { if (state.ws) state.ws.close(); } catch (_) {}
        try { if (typeof Engine3D !== 'undefined' && Engine3D.dispose) Engine3D.dispose(); } catch (_) {}
        state.ws = null;
        players = [];
        const gid = state.payload.gameId;
        setMenu(false);
        go('game', gid, false);
      };
    }
  };

  // Android-style back: close menu first
  window.__kavBack = () => {
    if (menuOpen) { setMenu(false); return true; }
    return false;
  };

  ws.onopen = () => { if (stat) stat.textContent = 'Connected'; };
  ws.onclose = () => { if (stat) stat.textContent = 'Connection lost'; };
  ws.onerror = () => { if (stat) stat.textContent = 'Game server unavailable'; };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'welcome') {
      players = m.players || [];
      objects = m.objects || objects;
      state._entities = m.entities || [];
      if (m.definition && m.definition.dimension) state.payload.dimension = m.definition.dimension;
      if (stat) stat.textContent = 'Players ' + players.length + (state.payload.dimension === '3d' ? ' · 3D' : '');
    }
    if (m.type === 'join' || m.type === 'leave') {
      players = m.players || players;
      if (stat) stat.textContent = 'Players ' + players.length;
    }
    if (m.type === 'state' && m.players) {
      players = m.players;
      if (m.entities) state._entities = m.entities;
    }
    if (m.type === 'state' && m.player) {
      players = players.filter((p) => p.id !== m.player.id).concat([m.player]);
    }
    if (m.type === 'pong' && stat) stat.textContent = 'Ping ' + (Date.now() - (state._pingAt || Date.now())) + 'ms · Players ' + players.length;
    if (m.type === 'error' && stat) stat.textContent = m.error || 'Error';
    if (state.payload.dimension === '3d' && typeof Engine3D !== 'undefined') {
      Engine3D.drawWorld(ctx, canvas.width, canvas.height, objects, players, state._entities || [], state._cam);
    } else {
      Engine.drawWorld(ctx, canvas.width, canvas.height, objects, players, null, state._entities || []);
    }
  };
  setInterval(() => { if (ws.readyState === 1) { state._pingAt = Date.now(); ws.send(JSON.stringify({ type: 'ping' })); } }, 5000);
  setInterval(() => {
    if (ws.readyState !== 1 || menuOpen) return;
    seq++;
    ws.send(JSON.stringify({ type: 'input', left: keys.left, right: keys.right, jump: keys.jump, attack: keys.attack, interact: keys.interact, sequence: seq }));
    keys.attack = false;
    keys.interact = false;
    keys.jump = false;
  }, 50);
  window.onkeydown = (e) => {
    if (menuOpen) return;
    if (e.key === 'ArrowLeft' || e.key === 'a') keys.left = true;
    if (e.key === 'ArrowRight' || e.key === 'd') keys.right = true;
    if (e.key === 'ArrowUp' || e.key === 'w' || e.key === ' ') { keys.jump = true; e.preventDefault(); }
    if (e.key === 'j' || e.key === 'J') keys.attack = true;
    if (e.key === 'e' || e.key === 'E') keys.interact = true;
    if (e.key === 'Escape') setMenu(!menuOpen);
  };
  window.onkeyup = (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'a') keys.left = false;
    if (e.key === 'ArrowRight' || e.key === 'd') keys.right = false;
  };
  canvas.ontouchstart = canvas.ontouchmove = (ev) => {
    if (menuOpen) return;
    const r = canvas.getBoundingClientRect();
    const x = ((ev.touches[0].clientX - r.left) / r.width);
    const y = ((ev.touches[0].clientY - r.top) / r.height);
    keys.left = x < 0.4;
    keys.right = x > 0.6;
    if (y < 0.35) keys.jump = true;
  };
  canvas.ontouchend = () => { keys.left = false; keys.right = false; };
}

function openGiftModal(username) {
  const host = document.getElementById('giftModal') || document.createElement('div');
  host.id = 'giftModal';
  host.hidden = false;
  host.innerHTML = `<div class="modal-back" id="giftBack"><div class="modal">
    <h3>Send Kavx Gift</h3>
    <p>Recipient: <b>@${esc(username)}</b></p>
    <input id="giftAmt" type="number" min="1" max="5000" placeholder="Kavx amount" inputmode="numeric" />
    <p id="giftMsg" class="muted"></p>
    <div class="row">
      <button class="btn" id="giftConfirm">Confirm Gift</button>
      <button class="ghost" id="giftCancel">Cancel</button>
    </div>
  </div></div>`;
  if (!host.parentNode) document.body.appendChild(host);
  document.getElementById('giftCancel').onclick = () => { host.hidden = true; host.innerHTML = ''; };
  document.getElementById('giftBack').onclick = (e) => { if (e.target.id === 'giftBack') { host.hidden = true; host.innerHTML = ''; } };
  const giftKey = 'gift_' + username + '_' + Date.now();
  document.getElementById('giftConfirm').onclick = async () => {
    const amount = Number(document.getElementById('giftAmt').value);
    const msg = document.getElementById('giftMsg');
    const btn = document.getElementById('giftConfirm');
    btn.disabled = true;
    btn.textContent = 'Sending...';
    try {
      const r = await Api.giftSend({ username, amount, idempotencyKey: giftKey });
      state.user.kavx = r.balance;
      msg.className = 'ok';
      msg.textContent = r.duplicate ? 'Already processed' : 'Kavx gift sent successfully.';
      setTimeout(() => { host.hidden = true; host.innerHTML = ''; render(); }, 800);
    } catch (e) {
      msg.className = 'err';
      msg.textContent = e.message;
      btn.disabled = false;
      btn.textContent = 'Confirm Gift';
    }
  };
}

boot().catch((e) => console.error(e));
