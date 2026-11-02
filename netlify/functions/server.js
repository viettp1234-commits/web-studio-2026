const crypto = require('crypto');
const fs = require('fs');
const querystring = require('querystring');

const TARGET_URL = 'https://lightvisual.studio';
const ADMIN_PASS = 'admin123';
const BRAND_NAME = 'AI Studio Pro';
const SECRET_KEY = 'khoa-bao-mat-proxy-2026-queue-vip';

const DB_FILE = '/tmp/database.json';
let db = {
    masterCookie: '_fbp=fb.1.1791519268646.363735489448337118; llmgw_session=M1Y2NgLnIDTr9nJ21I4RrvOGHLovdiW0pH8-obhseXE',
    masterCsrfToken: '',
    hideHistoryTabs: false,
    lastCreated: null,
    activeUser: null, // Tài khoản đang chiếm luồng chính
    queue: [],        // Danh sách tài khoản đang xếp hàng theo thứ tự ai nhập trước đứng trước
    users: {},
    kickedUsers: {}
};

function loadDB() {
    if (fs.existsSync(DB_FILE)) {
        try {
            const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            db = {
                ...db,
                ...loaded,
                queue: Array.isArray(loaded.queue) ? loaded.queue : [],
                users: { ...db.users, ...(loaded.users || {}) },
                kickedUsers: { ...db.kickedUsers, ...(loaded.kickedUsers || {}) }
            };
        } catch (e) {}
    }
}
function saveDB() {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8'); } catch (e) {}
}

// Hàm điều phối Hàng chờ 1 Luồng (Tự động đẩy người tiếp theo vào khi người cũ hết giờ/thoát)
function syncQueueEngine() {
    const now = Date.now();
    let changed = false;

    // 1. Kiểm tra người đang dùng luồng chính xem còn hạn hay đã bị đá/hết giờ
    if (db.activeUser) {
        const u = db.users[db.activeUser];
        if (!u || db.kickedUsers[db.activeUser]) {
            db.activeUser = null;
            changed = true;
        } else {
            if (!u.firstLoginAt) {
                u.firstLoginAt = now;
                changed = true;
            }
            const expireTime = u.firstLoginAt + u.durationMinutes * 60000;
            if (now >= expireTime) {
                u.isOnline = false;
                db.activeUser = null;
                changed = true;
            }
        }
    }

    // 2. Làm sạch danh sách hàng chờ (bỏ các nick đã bị xóa hoặc đã hết giờ từ trước)
    const cleanQueue = [];
    for (const qUser of db.queue) {
        const u = db.users[qUser];
        if (!u || db.kickedUsers[qUser]) {
            changed = true;
            continue;
        }
        if (u.firstLoginAt && (now >= u.firstLoginAt + u.durationMinutes * 60000)) {
            changed = true;
            continue;
        }
        if (!cleanQueue.includes(qUser) && qUser !== db.activeUser) {
            cleanQueue.push(qUser);
        } else {
            changed = true;
        }
    }
    db.queue = cleanQueue;

    // 3. Nếu luồng chính đang trống và có người trong hàng chờ -> Đẩy người #1 vào làm việc ngay!
    if (!db.activeUser && db.queue.length > 0) {
        const nextUser = db.queue.shift();
        const u = db.users[nextUser];
        if (u) {
            db.activeUser = nextUser;
            if (!u.firstLoginAt) {
                u.firstLoginAt = now; // Bắt đầu tính giây từ lúc thực sự được vào Studio!
            }
            u.isOnline = true;
            u.lastActiveAt = now;
            changed = true;
        }
    }

    if (changed) saveDB();
}

// Tính thời gian còn lại (giây) của một tài khoản
function getRemainSeconds(u, now = Date.now()) {
    if (!u) return 0;
    if (!u.firstLoginAt) return u.durationMinutes * 60;
    return Math.max(0, Math.floor((u.firstLoginAt + u.durationMinutes * 60000 - now) / 1000));
}

// Tính tổng số giây phải chờ của người ở vị trí index trong queue
function getEstimatedWaitSeconds(queueIndex) {
    const now = Date.now();
    let waitSec = 0;
    if (db.activeUser && db.users[db.activeUser]) {
        waitSec += getRemainSeconds(db.users[db.activeUser], now);
    }
    for (let i = 0; i < queueIndex; i++) {
        const qUser = db.users[db.queue[i]];
        if (qUser) waitSec += getRemainSeconds(qUser, now);
    }
    return waitSec;
}

function generateSmartAccount(durationMinutes, maxQuota) {
    const id = Math.floor(1000 + Math.random() * 9000);
    const username = `tk_${id}`;
    const mins36 = Math.min(46655, Math.max(1, durationMinutes)).toString(36).padStart(3, '0');
    const quota36 = Math.min(1295, Math.max(0, maxQuota)).toString(36).padStart(2, '0');
    const sig = crypto.createHmac('sha256', SECRET_KEY).update(`${username}:${mins36}:${quota36}`).digest('hex').slice(0, 4);
    const password = `${mins36}${quota36}${sig}`;
    return { username, password };
}

function verifySmartAccount(username, password) {
    if (!username || !password || password.length !== 9) return null;
    const mins36 = password.slice(0, 3);
    const quota36 = password.slice(3, 5);
    const sig = password.slice(5, 9);
    const expectedSig = crypto.createHmac('sha256', SECRET_KEY).update(`${username}:${mins36}:${quota36}`).digest('hex').slice(0, 4);
    if (sig !== expectedSig) return null;
    return {
        durationMinutes: parseInt(mins36, 36) || 60,
        maxQuota: parseInt(quota36, 36) || 0
    };
}

function getDeviceName(ua = '') {
    let os = 'Thiết bị khác';
    if (ua.includes('Windows')) os = '💻 Windows PC';
    else if (ua.includes('Macintosh') || ua.includes('Mac OS')) os = '💻 MacBook/Mac';
    else if (ua.includes('iPhone') || ua.includes('iPad')) os = '📱 iPhone/iPad';
    else if (ua.includes('Android')) os = '📱 Android';

    let browser = 'Web';
    if (ua.includes('Edg/')) browser = 'Edge';
    else if (ua.includes('Chrome/')) browser = 'Chrome';
    else if (ua.includes('Safari/') && !ua.includes('Chrome')) browser = 'Safari';
    else if (ua.includes('Firefox/')) browser = 'Firefox';
    return `${os} (${browser})`;
}

function signToken(data) {
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
    const sig = crypto.createHmac('sha256', SECRET_KEY).update(payload).digest('base64url');
    return `${payload}.${sig}`;
}

function verifyToken(token) {
    if (!token || !token.includes('.')) return null;
    const [payload, sig] = token.split('.');
    const expectedSig = crypto.createHmac('sha256', SECRET_KEY).update(payload).digest('base64url');
    if (sig !== expectedSig) return null;
    try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (e) { return null; }
}

function parseCookies(cookieHeader) {
    const list = {};
    if (!cookieHeader) return list;
    cookieHeader.split(';').forEach(cookie => {
        let [name, ...rest] = cookie.split('=');
        name = name?.trim();
        if (name) list[name] = decodeURIComponent(rest.join('=').trim());
    });
    return list;
}

function formatTimeVN(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h} giờ ${m} phút ${s} giây`;
    return `${m} phút ${s < 10 ? '0' : ''}${s} giây`;
}

exports.handler = async (event) => {
    loadDB();
    syncQueueEngine();

    const reqPath = event.path || '/';
    const method = event.httpMethod || 'GET';
    const query = event.queryStringParameters || {};
    const cookies = parseCookies(event.headers.cookie || event.headers.Cookie);
    const bodyText = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
    const clientIp = (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || 'Không rõ IP').split(',')[0].trim();
    const userAgent = event.headers['user-agent'] || '';

    // ==========================================
    // 1. TRANG ĐĂNG NHẬP & XẾP HÀNG (HIỆN TRẠNG THÁI LUỒNG TRỰC TIẾP)
    // ==========================================
    if (reqPath === '/sub-login' && method === 'GET') {
        const errorMsg = query.err || '';
        const isBusy = Boolean(db.activeUser);
        const activeRemain = isBusy ? getRemainSeconds(db.users[db.activeUser]) : 0;
        const totalWaitSec = getEstimatedWaitSeconds(db.queue.length);

        const liveStatusBanner = isBusy
            ? `<div style="background:rgba(245,158,11,0.12);border:1px solid #f59e0b;padding:12px;border-radius:10px;margin-bottom:16px;font-size:13px;line-height:1.6;">
                🔴 <b>Trạng thái máy:</b> Đang có người sử dụng (Còn <b>${formatTimeVN(activeRemain)}</b>)<br>
                👥 <b>Đang xếp hàng chờ:</b> <b>${db.queue.length} người</b><br>
                ⏳ <i>Đăng nhập ngay để lấy số thứ tự trong hàng chờ (Thời gian của bạn chỉ bắt đầu tính khi tới lượt vào!).</i>
               </div>`
            : `<div style="background:rgba(34,197,94,0.12);border:1px solid #22c55e;padding:12px;border-radius:10px;margin-bottom:16px;font-size:13px;color:#4ade80;text-align:center;">
                🟢 <b>Trạng thái máy: Đang trống!</b> Đăng nhập là vào thẳng Studio ngay lập tức.
               </div>`;

        return {
            statusCode: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Đăng nhập & Xếp hàng - ${BRAND_NAME}</title><style>body{background:#0b0b0c;color:#fff;font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.box{background:#161618;padding:32px;border-radius:14px;border:1px solid #2a2a2e;width:390px;box-shadow:0 10px 30px rgba(0,0,0,0.6)}h2{margin-top:0;text-align:center;color:#f59e0b}input{width:100%;padding:12px;margin:8px 0;border-radius:8px;border:1px solid #333;background:#0f0f10;color:#fff;box-sizing:border-box}button{width:100%;padding:12px;background:#ea580c;color:#fff;border:none;border-radius:8px;font-weight:bold;cursor:pointer;margin-top:10px;font-size:15px}.err{background:rgba(239,68,68,0.15);border:1px solid #ef4444;color:#f87171;padding:10px;border-radius:8px;font-size:13px;text-align:center;margin-bottom:12px}.note{color:#a1a1aa;font-size:12px;text-align:center;margin-top:14px;line-height:1.5}</style></head>
            <body><div class="box">
                <h2>${BRAND_NAME}</h2>
                ${liveStatusBanner}
                ${errorMsg ? `<div class="err">${errorMsg}</div>` : ''}
                <form method="POST" action="/sub-login">
                    <input type="text" name="username" placeholder="Nhập Tài khoản được cấp" required />
                    <input type="password" name="password" placeholder="Nhập Mật khẩu" required />
                    <button type="submit">${isBusy ? '⏳ Đăng Nhập Để Xếp Hàng Chờ' : '🚀 Vào Studio Ngay'}</button>
                </form>
                <div class="note">Ai nhập tài khoản trước sẽ được xếp vào trước. Khi đang trong hàng chờ, số phút của bạn được giữ nguyên 100%.</div>
            </div></body></html>`
        };
    }

    if (reqPath === '/sub-login' && method === 'POST') {
        const form = querystring.parse(bodyText);
        const username = (form.username || '').trim();
        const password = (form.password || '').trim();

        const savedAcctCookie = verifyToken(cookies[`acct_${username}`]);
        if (db.kickedUsers[username] || (savedAcctCookie && savedAcctCookie.kicked)) {
            return {
                statusCode: 302,
                headers: { Location: '/sub-login?err=' + encodeURIComponent('Tài khoản này đã bị Admin xóa hoặc thu hồi!') }
            };
        }

        let user = db.users[username];
        const smartInfo = verifySmartAccount(username, password);

        if ((!user || user.password !== password) && !smartInfo) {
            return { statusCode: 302, headers: { Location: '/sub-login?err=' + encodeURIComponent('Sai tài khoản hoặc mật khẩu!') } };
        }

        if (!user && smartInfo) {
            user = {
                password,
                durationMinutes: smartInfo.durationMinutes,
                maxQuota: smartInfo.maxQuota,
                usedQuota: 0,
                firstLoginAt: null,
                isOnline: false,
                device: '-',
                ip: '-'
            };
            db.users[username] = user;
        }

        const now = Date.now();
        if (savedAcctCookie && savedAcctCookie.username === username) {
            if (savedAcctCookie.firstLoginAt && (!user.firstLoginAt || savedAcctCookie.firstLoginAt < user.firstLoginAt)) {
                user.firstLoginAt = savedAcctCookie.firstLoginAt;
            }
            if ((savedAcctCookie.usedQuota || 0) > (user.usedQuota || 0)) {
                user.usedQuota = savedAcctCookie.usedQuota;
            }
        }

        // Kiểm tra nếu tài khoản đã từng kích hoạt trước đó và đã hết sạch thời gian
        if (user.firstLoginAt && (now >= user.firstLoginAt + user.durationMinutes * 60000)) {
            saveDB();
            return {
                statusCode: 302,
                headers: { Location: '/sub-login?err=' + encodeURIComponent('Tài khoản này đã sử dụng hết thời gian!') }
            };
        }

        user.device = getDeviceName(userAgent);
        user.ip = clientIp;
        user.lastActiveAt = now;

        // XỬ LÝ LUỒNG CHÍNH HOẶC ĐƯA VÀO HÀNG CHỜ (FIFO)
        if (!db.activeUser || db.activeUser === username) {
            db.activeUser = username;
            if (!user.firstLoginAt) user.firstLoginAt = now; // Bắt đầu tính giây!
            user.isOnline = true;
            db.queue = db.queue.filter(u => u !== username);
        } else {
            // Đang có người khác dùng -> Xếp vào hàng chờ nếu chưa có trong hàng chờ
            if (!db.queue.includes(username)) {
                db.queue.push(username);
                user.queuedAt = now;
            }
            user.isOnline = true;
        }
        saveDB();

        const token = signToken({
            username,
            durationMinutes: user.durationMinutes,
            maxQuota: user.maxQuota || 0,
            usedQuota: user.usedQuota || 0,
            firstLoginAt: user.firstLoginAt,
            kicked: false
        });

        return {
            statusCode: 302,
            multiValueHeaders: {
                'Set-Cookie': [
                    `sub_token=${token}; Path=/; HttpOnly; Max-Age=86400`,
                    `acct_${username}=${token}; Path=/; HttpOnly; Max-Age=2592000`
                ]
            },
            headers: { 'Location': db.activeUser === username ? '/' : '/waiting-room' }
        };
    }

    if (reqPath === '/sub-logout') {
        const session = verifyToken(cookies.sub_token);
        if (session) {
            const uName = session.username;
            if (db.users[uName]) db.users[uName].isOnline = false;
            // Nếu người đang dùng hoặc đang xếp hàng bấm Thoát -> Nhường luồng ngay cho người kế tiếp!
            if (db.activeUser === uName) {
                db.activeUser = null;
            }
            db.queue = db.queue.filter(u => u !== uName);
            syncQueueEngine();
            saveDB();
        }

        let msg = 'Bạn đã thoát khỏi phiên/hàng chờ. Nếu tài khoản còn thời gian, bạn có thể đăng nhập lại sau!';
        if (query.reason === 'timeout') msg = 'Tài khoản của bạn đã hết thời gian sử dụng!';
        if (query.reason === 'kicked') msg = 'Tài khoản của bạn đã bị Admin xóa hoặc đá khỏi hệ thống!';

        return {
            statusCode: 302,
            headers: {
                'Set-Cookie': 'sub_token=; Path=/; HttpOnly; Max-Age=0',
                'Location': '/sub-login?err=' + encodeURIComponent(msg)
            }
        };
    }

    // ==========================================
    // 2. GIAO DIỆN PHÒNG CHỜ VIP (KHI ĐANG CÓ NGƯỜI DÙNG LUỒNG CHÍNH)
    // ==========================================
    if (reqPath === '/waiting-room') {
        const session = verifyToken(cookies.sub_token);
        if (!session) return { statusCode: 302, headers: { Location: '/sub-login' } };

        const username = session.username;
        if (db.kickedUsers[username]) {
            return { statusCode: 302, headers: { Location: '/sub-logout?reason=kicked' } };
        }

        // Nếu đã tới lượt -> Chuyển thẳng vào Studio!
        if (db.activeUser === username) {
            return { statusCode: 302, headers: { Location: '/' } };
        }

        // Đảm bảo user nằm trong hàng chờ
        if (!db.queue.includes(username)) {
            if (!db.activeUser) {
                db.activeUser = username;
                if (db.users[username] && !db.users[username].firstLoginAt) {
                    db.users[username].firstLoginAt = Date.now();
                }
                saveDB();
                return { statusCode: 302, headers: { Location: '/' } };
            }
            db.queue.push(username);
            saveDB();
        }

        const qIndex = db.queue.indexOf(username);
        const position = qIndex + 1;
        const waitSeconds = getEstimatedWaitSeconds(qIndex);
        const activeRemainSec = db.activeUser ? getRemainSeconds(db.users[db.activeUser]) : 0;
        const myUser = db.users[username] || session;
        const myPackageMins = myUser.durationMinutes || 60;

        return {
            statusCode: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Phòng Chờ Đến Lượt - ${BRAND_NAME}</title>
            <style>
                body{background:#09090b;color:#fff;font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:20px}
                .card{background:#141417;border:1px solid #27272a;border-radius:18px;padding:34px;max-width:500px;width:100%;box-shadow:0 15px 40px rgba(0,0,0,0.8);text-align:center}
                .badge{display:inline-block;background:rgba(245,158,11,0.15);border:1px solid #f59e0b;color:#facc15;padding:6px 16px;border-radius:99px;font-weight:bold;font-size:14px;margin-bottom:16px}
                .pos-box{background:#1c1c21;border:1px solid #3f3f46;border-radius:14px;padding:20px;margin:18px 0}
                .pos-num{font-size:44px;font-weight:800;color:#f59e0b;margin:4px 0}
                .wait-time{font-size:22px;font-weight:bold;color:#38bdf8;margin-top:8px}
                .info-row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #27272a;font-size:14px;color:#d4d4d8}
                .btn-out{display:inline-block;margin-top:22px;padding:10px 20px;background:#27272a;color:#f87171;text-decoration:none;border-radius:8px;font-weight:bold;font-size:14px}
                .btn-out:hover{background:#3f3f46}
                .pulse{display:inline-block;width:10px;height:10px;background:#22c55e;border-radius:50%;margin-right:6px;animation:blink 1.2s infinite}
                @keyframes blink{0%,100%{opacity:1}50%{opacity:0.3}}
            </style></head>
            <body>
                <div class="card">
                    <div class="badge"><span class="pulse"></span>HỆ THỐNG ĐANG XẾP HÀNG TỰ ĐỘNG (1 LUỒNG)</div>
                    <h2 style="margin:0 0 8px 0;">Xin chào, <span style="color:#f59e0b;">${username}</span>!</h2>
                    <p style="color:#a1a1aa;font-size:14px;margin:0;">Hiện đang có người sử dụng Studio. Hệ thống sẽ tự động mở cửa đưa bạn vào ngay khi tới lượt!</p>

                    <div class="pos-box">
                        <div style="color:#a1a1aa;font-size:13px;text-transform:uppercase;letter-spacing:1px;">Vị trí hàng chờ của bạn</div>
                        <div class="pos-num" id="pos-val">#${position}</div>
                        <div style="color:#a1a1aa;font-size:13px;margin-top:10px;">Thời gian chờ dự kiến tối đa:</div>
                        <div class="wait-time" id="wait-val">${formatTimeVN(waitSeconds)}</div>
                    </div>

                    <div class="info-row"><span>👤 Người đang dùng hiện tại còn:</span><b id="active-val" style="color:#facc15;">${formatTimeVN(activeRemainSec)}</b></div>
                    <div class="info-row"><span>🎁 Gói thời gian của bạn:</span><b style="color:#4ade80;">${myPackageMins} phút (Chưa bị trừ giây nào)</b></div>
                    <div class="info-row"><span>👥 Tổng số người trong hàng chờ:</span><b id="total-q">${db.queue.length} người</b></div>

                    <p style="color:#71717a;font-size:12.5px;margin-top:16px;line-height:1.5;">
                        💡 <b>Mẹo:</b> Vui lòng <b>giữ nguyên tab này</b>. Nếu người phía trước bấm Thoát sớm hơn dự kiến, bạn sẽ được chuyển thẳng vào Studio ngay lập tức!
                    </p>
                    <a href="/sub-logout" class="btn-out">Rời khỏi hàng chờ</a>
                </div>

                <script>
                    let waitSec = ${waitSeconds};
                    let activeSec = ${activeRemainSec};

                    function fmt(sec) {
                        sec = Math.max(0, sec);
                        const h = Math.floor(sec / 3600);
                        const m = Math.floor((sec % 3600) / 60);
                        const s = sec % 60;
                        if (h > 0) return h + ' giờ ' + m + ' phút ' + s + ' giây';
                        return m + ' phút ' + (s < 10 ? '0' : '') + s + ' giây';
                    }

                    // Đếm ngược mượt mà mỗi giây
                    setInterval(() => {
                        if (waitSec > 0) waitSec--;
                        if (activeSec > 0) activeSec--;
                        document.getElementById('wait-val').textContent = fmt(waitSec);
                        document.getElementById('active-val').textContent = fmt(activeSec);
                    }, 1000);

                    // Kiểm tra lượt mỗi 3 giây -> Tới lượt là tự nhảy vào Studio luôn!
                    setInterval(() => {
                        fetch('/sub-status').then(r => r.json()).then(data => {
                            if (!data.valid) {
                                window.location.href = '/sub-logout?reason=' + (data.reason || 'kicked');
                                return;
                            }
                            if (data.status === 'active') {
                                window.location.href = '/';
                                return;
                            }
                            if (data.position) {
                                document.getElementById('pos-val').textContent = '#' + data.position;
                                document.getElementById('total-q').textContent = data.queueLength + ' người';
                                waitSec = data.waitSeconds;
                                activeSec = data.activeRemainSeconds;
                            }
                        }).catch(() => {});
                    }, 3000);
                </script>
            </body></html>`
        };
    }

    // ==========================================
    // 3. API ĐỒNG BỘ TRẠNG THÁI NGẦM CHO CẢ PHÒNG CHỜ & STUDIO
    // ==========================================
    if (reqPath === '/sub-status') {
        const session = verifyToken(cookies.sub_token);
        if (!session) {
            return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ valid: false, reason: 'timeout' }) };
        }

        const username = session.username;
        if (db.kickedUsers[username]) {
            const kickedToken = signToken({ ...session, kicked: true });
            return {
                statusCode: 200,
                multiValueHeaders: {
                    'Set-Cookie': [
                        'sub_token=; Path=/; HttpOnly; Max-Age=0',
                        `acct_${username}=${kickedToken}; Path=/; HttpOnly; Max-Age=2592000`
                    ]
                },
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ valid: false, reason: 'kicked' })
            };
        }

        if (!db.users[username]) {
            db.users[username] = {
                password: '(Đã mã hóa)',
                durationMinutes: session.durationMinutes || 60,
                maxQuota: session.maxQuota || 0,
                usedQuota: session.usedQuota || 0,
                firstLoginAt: session.firstLoginAt || null,
                isOnline: true,
                device: getDeviceName(userAgent),
                ip: clientIp
            };
        }

        const user = db.users[username];
        user.isOnline = true;
        user.lastActiveAt = Date.now();
        user.device = getDeviceName(userAgent);
        user.ip = clientIp;

        syncQueueEngine();

        // Trường hợp 1: Đang là người dùng chính trong Studio
        if (db.activeUser === username) {
            const remainSec = getRemainSeconds(user);
            if (remainSec <= 0) {
                db.activeUser = null;
                syncQueueEngine();
                saveDB();
                return {
                    statusCode: 200,
                    headers: { 'Set-Cookie': 'sub_token=; Path=/; HttpOnly; Max-Age=0', 'content-type': 'application/json' },
                    body: JSON.stringify({ valid: false, reason: 'timeout' })
                };
            }

            if (method === 'POST' && query.action === 'increment') {
                if (user.maxQuota > 0 && user.usedQuota >= user.maxQuota) {
                    return {
                        statusCode: 429,
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ valid: true, status: 'active', allowed: false, usedQuota: user.usedQuota, maxQuota: user.maxQuota, queueLength: db.queue.length })
                    };
                }
                user.usedQuota = (user.usedQuota || 0) + 1;
            }
            saveDB();

            const newToken = signToken({ ...session, firstLoginAt: user.firstLoginAt, usedQuota: user.usedQuota });
            return {
                statusCode: 200,
                multiValueHeaders: {
                    'Set-Cookie': [
                        `sub_token=${newToken}; Path=/; HttpOnly; Max-Age=86400`,
                        `acct_${username}=${newToken}; Path=/; HttpOnly; Max-Age=2592000`
                    ]
                },
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    valid: true,
                    status: 'active',
                    allowed: !(user.maxQuota > 0 && user.usedQuota > user.maxQuota),
                    remainSeconds: remainSec,
                    usedQuota: user.usedQuota || 0,
                    maxQuota: user.maxQuota || 0,
                    queueLength: db.queue.length
                })
            };
        }

        // Trường hợp 2: Đang ở trong hàng chờ
        if (!db.queue.includes(username)) {
            if (user.firstLoginAt && getRemainSeconds(user) <= 0) {
                return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ valid: false, reason: 'timeout' }) };
            }
            db.queue.push(username);
            syncQueueEngine();
        }

        if (db.activeUser === username) {
            return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ valid: true, status: 'active' }) };
        }

        const qIdx = db.queue.indexOf(username);
        const waitSeconds = getEstimatedWaitSeconds(qIdx);
        const activeRemainSeconds = db.activeUser ? getRemainSeconds(db.users[db.activeUser]) : 0;
        saveDB();

        return {
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                valid: true,
                status: 'queued',
                position: qIdx + 1,
                queueLength: db.queue.length,
                waitSeconds,
                activeRemainSeconds
            })
        };
    }

    // ==========================================
    // 4. TRANG QUẢN TRỊ ADMIN (QUẢN LÝ LUỒNG CHÍNH & DANH SÁCH HÀNG CHỜ)
    // ==========================================
    if (reqPath.startsWith('/my-admin')) {
        if (query.pass !== ADMIN_PASS) {
            return { statusCode: 403, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Sai mật khẩu Admin!' };
        }

        if (reqPath === '/my-admin/config' && method === 'POST') {
            const form = querystring.parse(bodyText);
            db.masterCookie = (form.masterCookie || '').trim();
            db.masterCsrfToken = (form.masterCsrfToken || '').trim();
            db.hideHistoryTabs = Boolean(form.hideHistoryTabs);
            saveDB();
            return { statusCode: 302, headers: { Location: `/my-admin?pass=${ADMIN_PASS}` } };
        }

        if (reqPath === '/my-admin/random-user' && method === 'POST') {
            const form = querystring.parse(bodyText);
            const mins = Math.max(1, parseInt(form.durationMinutes, 10) || 60);
            const rawQuota = (form.maxQuota || '').trim();
            const maxQuota = rawQuota === '' ? 0 : Math.max(0, parseInt(rawQuota, 10) || 0);

            const { username, password } = generateSmartAccount(mins, maxQuota);
            delete db.kickedUsers[username];

            db.users[username] = {
                password,
                durationMinutes: mins,
                maxQuota,
                usedQuota: 0,
                firstLoginAt: null,
                isOnline: false,
                device: 'Chưa đăng nhập',
                ip: '-'
            };
            db.lastCreated = { username, password, durationMinutes: mins, maxQuota };
            saveDB();
            return { statusCode: 302, headers: { Location: `/my-admin?pass=${ADMIN_PASS}` } };
        }

        // Nút ưu tiên đẩy 1 người trong hàng chờ vào thẳng luồng chính
        if (reqPath === '/my-admin/promote') {
            const targetUser = query.user;
            if (targetUser && db.users[targetUser]) {
                if (db.activeUser && db.activeUser !== targetUser) {
                    db.queue.unshift(db.activeUser);
                }
                db.queue = db.queue.filter(u => u !== targetUser);
                db.activeUser = targetUser;
                if (!db.users[targetUser].firstLoginAt) {
                    db.users[targetUser].firstLoginAt = Date.now();
                }
                saveDB();
            }
            return { statusCode: 302, headers: { Location: `/my-admin?pass=${ADMIN_PASS}` } };
        }

        if (reqPath === '/my-admin/delete') {
            const targetUser = query.user;
            if (targetUser) {
                db.kickedUsers[targetUser] = true;
                if (db.activeUser === targetUser) db.activeUser = null;
                db.queue = db.queue.filter(u => u !== targetUser);
                delete db.users[targetUser];
                syncQueueEngine();
                saveDB();
            }
            return { statusCode: 302, headers: { Location: `/my-admin?pass=${ADMIN_PASS}` } };
        }

        const userRows = Object.entries(db.users).reverse().map(([u, info]) => {
            let roleBadge = `<span style="color:#a1a1aa;">⚪ Chưa đăng nhập</span>`;
            let timeDetail = `<span style="color:#a1a1aa;">Còn nguyên ${info.durationMinutes} phút</span>`;
            const qIdx = db.queue.indexOf(u);

            if (db.activeUser === u) {
                const remSec = getRemainSeconds(info);
                roleBadge = `<span style="background:#14532d;border:1px solid #22c55e;color:#4ade80;padding:4px 10px;border-radius:99px;font-weight:bold;font-size:12px;">🟢 ĐANG DÙNG LUỒNG CHÍNH</span>`;
                timeDetail = `<b class="admin-live-timer" data-sec="${remSec}" style="color:#f59e0b;font-size:14px;">${formatTimeVN(remSec)}</b>`;
            } else if (qIdx !== -1) {
                const waitSec = getEstimatedWaitSeconds(qIdx);
                roleBadge = `<span style="background:#422006;border:1px solid #f59e0b;color:#facc15;padding:4px 10px;border-radius:99px;font-weight:bold;font-size:12px;">⏳ ĐANG XẾP HÀNG SỐ #${qIdx + 1}</span>`;
                timeDetail = `<span style="color:#38bdf8;">Chờ khoảng: <b class="admin-live-timer" data-sec="${waitSec}">${formatTimeVN(waitSec)}</b></span><br><small style="color:#a1a1aa;">(Gói ${info.durationMinutes}p chưa trừ)</small>`;
            } else if (info.firstLoginAt) {
                const remSec = getRemainSeconds(info);
                if (remSec > 0) {
                    roleBadge = `<span style="color:#eab308;font-weight:bold;">🟡 Đã thoát (Nhường luồng)</span>`;
                    timeDetail = `<b class="admin-live-timer" data-sec="${remSec}" style="color:#eab308;">Còn ${formatTimeVN(remSec)}</b>`;
                } else {
                    roleBadge = `<span style="color:#ef4444;font-weight:bold;">🔴 Đã hết giờ</span>`;
                    timeDetail = `<span style="color:#ef4444;">00 phút 00 giây</span>`;
                }
            }

            const quotaText = info.maxQuota > 0
                ? `<b style="color:${info.usedQuota >= info.maxQuota ? '#ef4444' : '#38bdf8'};">${info.usedQuota || 0} / ${info.maxQuota} lượt</b>`
                : `<b style="color:#22c55e;">${info.usedQuota || 0} / Vô hạn (∞)</b>`;

            const quotaLabel = info.maxQuota > 0 ? `${info.maxQuota} lượt` : 'Vô hạn';
            const copyText = `Link: https://${event.headers.host} | TK: ${u} | MK: ${info.password} (${info.durationMinutes} phút - Tạo: ${quotaLabel})`;

            return `<tr>
                <td><b style="color:#f59e0b;font-size:15px;">${u}</b></td>
                <td><code style="background:#27272a;padding:4px 8px;border-radius:4px;font-size:14px;">${info.password}</code></td>
                <td><b>${info.durationMinutes} phút</b></td>
                <td>${roleBadge}</td>
                <td>${timeDetail}</td>
                <td>${quotaText}</td>
                <td><b>${info.device || '-'}</b><br><span style="font-size:12px;color:#a1a1aa;">IP: ${info.ip || '-'}</span></td>
                <td>
                    <button type="button" onclick="navigator.clipboard.writeText('${copyText}');this.textContent='Đã Copy!';" style="padding:6px 10px;font-size:12px;margin-right:4px;background:#3b82f6;color:#fff;">Copy</button>
                    ${db.activeUser !== u ? `<a href="/my-admin/promote?pass=${ADMIN_PASS}&user=${u}" style="background:#22c55e;color:#000;padding:6px 10px;border-radius:6px;font-size:12px;font-weight:bold;text-decoration:none;margin-right:4px;">⚡ Cho vào ngay</a>` : ''}
                    <a href="/my-admin/delete?pass=${ADMIN_PASS}&user=${u}" style="background:#ef4444;color:#fff;padding:6px 10px;border-radius:6px;font-size:12px;font-weight:bold;text-decoration:none;">🚫 Xóa / Đá</a>
                </td>
            </tr>`;
        }).join('');

        const lastCreatedBox = db.lastCreated ? `
            <div style="background:#14532d;border:1px solid #22c55e;padding:14px;border-radius:8px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
                <div>
                    ✅ <b>Vừa tạo TK mới:</b> 
                    Tài khoản: <b style="color:#facc15;font-size:16px;">${db.lastCreated.username}</b> | 
                    Mật khẩu: <b style="color:#facc15;font-size:16px;">${db.lastCreated.password}</b> | 
                    Gói: <b>${db.lastCreated.durationMinutes} phút</b> | 
                    Lượt tạo: <b>${db.lastCreated.maxQuota > 0 ? db.lastCreated.maxQuota + ' lượt' : 'Vô hạn'}</b>
                </div>
                <button type="button" onclick="navigator.clipboard.writeText('Link: https://${event.headers.host}\\nTài khoản: ${db.lastCreated.username}\\nMật khẩu: ${db.lastCreated.password}\\nThời lượng: ${db.lastCreated.durationMinutes} phút\\nSố lượt tạo Ảnh/Video: ${db.lastCreated.maxQuota > 0 ? db.lastCreated.maxQuota + ' lượt' : 'Vô hạn'}');this.textContent='Đã Copy!';" style="background:#22c55e;color:#000;">📋 Copy gửi khách</button>
            </div>` : '';

        return {
            statusCode: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Admin Hàng Chờ 1 Luồng - ${BRAND_NAME}</title><style>body{background:#0f0f11;color:#e4e4e7;font-family:system-ui,sans-serif;padding:24px;max-width:1240px;margin:auto}.card{background:#18181b;padding:20px;border-radius:10px;border:1px solid #27272a;margin-bottom:22px}input,textarea{width:100%;padding:11px;margin:6px 0 14px;background:#09090b;border:1px solid #3f3f46;color:#fff;border-radius:6px;box-sizing:border-box}button{background:#f59e0b;color:#000;border:none;padding:11px 20px;border-radius:6px;font-weight:bold;cursor:pointer}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{border:1px solid #27272a;padding:10px;text-align:left;font-size:13px}th{background:#27272a}</style></head>
            <body>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                    <h2 style="margin:0;">Quản trị Luồng & Hàng Chờ (${BRAND_NAME})</h2>
                    <div style="background:#18181b;border:1px solid #3f3f46;padding:8px 16px;border-radius:99px;font-size:14px;">
                        👤 Đang dùng: <b style="color:#4ade80;">${db.activeUser || 'Đang trống'}</b> &nbsp;|&nbsp; 
                        👥 Đang xếp hàng chờ: <b style="color:#facc15;">${db.queue.length} người</b>
                    </div>
                </div>
                
                <div class="card">
                    <h3>🎲 1. Tạo Tài khoản Mới (Nhập số phút, VD: 60 = 1 tiếng, 120 = 2 tiếng)</h3>
                    ${lastCreatedBox}
                    <form method="POST" action="/my-admin/random-user?pass=${ADMIN_PASS}" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
                        <input type="number" name="durationMinutes" placeholder="Số phút sử dụng (VD: 60, 120, 180...)" required style="margin:0;flex:1;min-width:220px;font-size:15px;" />
                        <input type="number" name="maxQuota" placeholder="Giới hạn lượt tạo Ảnh/Video (VD: 20, để trống = Vô hạn)" style="margin:0;flex:1.3;min-width:260px;font-size:15px;" />
                        <button type="submit" style="white-space:nowrap;font-size:15px;">🎲 Tạo TK Ngẫu Nhiên</button>
                    </form>
                </div>

                <div class="card">
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <h3>🖥️ 2. Danh sách Luồng Chính, Thứ tự Hàng Chờ & Thiết bị</h3>
                        <a href="/my-admin?pass=${ADMIN_PASS}" style="color:#f59e0b;text-decoration:none;font-size:14px;">🔄 Làm mới bảng</a>
                    </div>
                    <table>
                        <tr><th>Tài khoản</th><th>Mật khẩu</th><th>Gói</th><th>Vị trí / Luồng</th><th>Thời gian còn / Chờ dự kiến</th><th>Lượt tạo</th><th>Thiết bị / IP</th><th>Thao tác</th></tr>
                        ${userRows || '<tr><td colspan="8" style="text-align:center;color:#71717a;">Chưa có tài khoản nào.</td></tr>'}
                    </table>
                </div>

                <div class="card">
                    <h3>⚙️ 3. Cấu hình Cookie & X-CSRF-Token gốc</h3>
                    <form method="POST" action="/my-admin/config?pass=${ADMIN_PASS}">
                        <textarea name="masterCookie" rows="2">${db.masterCookie}</textarea>
                        <input type="text" name="masterCsrfToken" value="${db.masterCsrfToken}" placeholder="X-CSRF-Token (Nếu có)..." />
                        <label><input type="checkbox" name="hideHistoryTabs" style="width:auto;" ${db.hideHistoryTabs ? 'checked' : ''} /> Ẩn luôn tab Dự án & Thư viện</label><br><br>
                        <button type="submit">Lưu Cấu Hình Gốc</button>
                    </form>
                </div>

                <script>
                    function fmt(sec) {
                        sec = Math.max(0, sec);
                        const h = Math.floor(sec / 3600);
                        const m = Math.floor((sec % 3600) / 60);
                        const s = sec % 60;
                        if (h > 0) return h + ' giờ ' + m + ' phút ' + s + ' giây';
                        return m + ' phút ' + (s < 10 ? '0' : '') + s + ' giây';
                    }
                    setInterval(() => {
                        document.querySelectorAll('.admin-live-timer').forEach(el => {
                            let sec = parseInt(el.getAttribute('data-sec'), 10);
                            if (sec > 0) {
                                sec--;
                                el.setAttribute('data-sec', sec);
                                el.textContent = fmt(sec);
                            }
                        });
                    }, 1000);
                </script>
            </body></html>`
        };
    }

    // ==========================================
    // 5. KIỂM TRA QUYỀN LUỒNG CHÍNH TRƯỚC KHI VÀO STUDIO
    // ==========================================
    const session = verifyToken(cookies.sub_token);
    if (!session) {
        return { statusCode: 302, headers: { Location: '/sub-login' } };
    }

    const username = session.username;
    if (db.kickedUsers[username]) {
        return { statusCode: 302, headers: { Location: '/sub-logout?reason=kicked' } };
    }

    // Nếu người này chưa tới lượt (không phải activeUser) -> Đưa sang Phòng chờ!
    if (db.activeUser !== username) {
        return { statusCode: 302, headers: { Location: '/waiting-room' } };
    }

    const currentUser = db.users[username];
    if (!currentUser || getRemainSeconds(currentUser) <= 0) {
        db.activeUser = null;
        syncQueueEngine();
        saveDB();
        return { statusCode: 302, headers: { Location: '/sub-logout?reason=timeout' } };
    }

    if (reqPath.toLowerCase() === '/app/api' || reqPath.toLowerCase().startsWith('/v1/keys')) {
        return { statusCode: 302, headers: { Location: '/' } };
    }

    const isGeneratePost = method === 'POST' && !reqPath.includes('auth') && !reqPath.includes('login');
    if (isGeneratePost && currentUser.maxQuota > 0 && currentUser.usedQuota >= currentUser.maxQuota) {
        return {
            statusCode: 429,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ error: { message: `Bạn đã dùng hết giới hạn ${currentUser.maxQuota} lượt tạo Ảnh/Video!` } })
        };
    }

    // ==========================================
    // 6. CHUYỂN TIẾP SANG WEB GỐC & HIỂN THỊ THANH TRẠNG THÁI TRÊN STUDIO
    // ==========================================
    const queryStr = event.rawQuery ? `?${event.rawQuery}` : '';
    const targetFullUrl = `${TARGET_URL}${reqPath}${queryStr}`;

    const fetchHeaders = {
        'Cookie': db.masterCookie,
        'Origin': TARGET_URL,
        'Referer': `${TARGET_URL}/`,
        'User-Agent': userAgent || 'Mozilla/5.0',
        'Accept': event.headers['accept'] || '*/*'
    };

    const clientCsrf = event.headers['x-csrf-token'] || event.headers['X-CSRF-Token'] || event.headers['x-xsrf-token'] || db.masterCsrfToken;
    if (clientCsrf) fetchHeaders['X-CSRF-Token'] = clientCsrf;
    if (event.headers['content-type']) fetchHeaders['Content-Type'] = event.headers['content-type'];
    if (event.headers['authorization']) fetchHeaders['Authorization'] = event.headers['authorization'];

    try {
        const response = await fetch(targetFullUrl, {
            method,
            headers: fetchHeaders,
            body: ['GET', 'HEAD'].includes(method) ? undefined : (event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body)
        });

        const contentType = response.headers.get('content-type') || '';
        const resCsrf = response.headers.get('x-csrf-token');
        if (resCsrf) db.masterCsrfToken = resCsrf;

        if (contentType.includes('text/html')) {
            let html = await response.text();
            html = html.replace(/lightvisual\.studio/gi, BRAND_NAME).replace(/lightvisual/gi, BRAND_NAME);
            const remainSec = getRemainSeconds(currentUser);
            const usedQ = currentUser.usedQuota || 0;
            const maxQ = currentUser.maxQuota || 0;
            const hideHistory = db.hideHistoryTabs ? 'true' : 'false';

            const shield = `<style>
                a[href*="/api"], a[href*="zalo.me"], a[href*="pricing"], a[href*="billing"], a[href*="netlify.com"], iframe[src*="netlify"] { display: none !important; }
                #custom-timer-bar {
                    position: fixed; top: 8px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
                    background: #161618; border: 1px solid #f59e0b;
                    color: #fff; padding: 6px 18px; border-radius: 99px;
                    font-family: system-ui, sans-serif; font-size: 13px;
                    box-shadow: 0 4px 20px rgba(0,0,0,0.9); white-space: nowrap;
                    display: flex; align-items: center; gap: 10px;
                }
            </style>
            <div id="custom-timer-bar">
                <span>🟢 <b>${username}</b></span>
                <span>|</span>
                <span>⏳ Còn: <b id="time-left-val" style="color:#f59e0b;">-- phút -- giây</b></span>
                <span>|</span>
                <span>🎨 Tạo: <b id="quota-val" style="color:#38bdf8;">${usedQ}/${maxQ > 0 ? maxQ : '∞'}</b></span>
                <span>|</span>
                <span>👥 Đang chờ sau bạn: <b id="queue-count-val" style="color:#facc15;">${db.queue.length} người</b></span>
                <span>|</span>
                <a href="/sub-logout" style="color:#ef4444;font-weight:bold;text-decoration:none;">Thoát (Nhường lượt)</a>
            </div>
            <script>
                (function(){
                    let sec = ${remainSec};
                    let usedQuota = ${usedQ};
                    let maxQuota = ${maxQ};
                    const tEl = document.getElementById('time-left-val');
                    const qEl = document.getElementById('quota-val');
                    const qCountEl = document.getElementById('queue-count-val');

                    function renderQuota() {
                        if (!qEl) return;
                        qEl.textContent = usedQuota + ' / ' + (maxQuota > 0 ? maxQuota : 'Vô hạn');
                        if (maxQuota > 0 && usedQuota >= maxQuota) {
                            qEl.style.color = '#ef4444';
                            qEl.textContent += ' (MAX)';
                        }
                    }
                    renderQuota();

                    setInterval(() => {
                        sec--;
                        if (sec <= 0) {
                            window.location.href = '/sub-logout?reason=timeout';
                        }
                        if (tEl && sec >= 0) {
                            const h = Math.floor(sec / 3600);
                            const m = Math.floor((sec % 3600) / 60);
                            const s = sec % 60;
                            tEl.textContent = (h > 0 ? h + 'h ' : '') + m + 'p ' + (s < 10 ? '0' : '') + s + 's';
                        }
                    }, 1000);

                    const origFetch = window.fetch;
                    setInterval(() => {
                        origFetch('/sub-status').then(r => r.json()).then(data => {
                            if (!data.valid) {
                                window.location.href = '/sub-logout?reason=' + (data.reason || 'kicked');
                            } else if (data.status === 'queued') {
                                window.location.href = '/waiting-room';
                            } else {
                                usedQuota = data.usedQuota;
                                maxQuota = data.maxQuota;
                                if (qCountEl) qCountEl.textContent = (data.queueLength || 0) + ' người';
                                renderQuota();
                            }
                        }).catch(() => {});
                    }, 4000);

                    document.addEventListener('click', function(e) {
                        const btn = e.target.closest('button');
                        if (!btn) return;
                        const txt = (btn.textContent || '').trim();
                        if (/^Tạo(\\s|•|$)/i.test(txt) || txt.includes('Tạo ảnh') || txt.includes('Tạo video') || txt.includes('Chạy Excel')) {
                            if (maxQuota > 0 && usedQuota >= maxQuota) {
                                e.preventDefault();
                                e.stopPropagation();
                                alert('⛔ Bạn đã sử dụng hết giới hạn ' + maxQuota + '/' + maxQuota + ' lượt tạo Ảnh/Video!');
                                return false;
                            }
                            usedQuota++;
                            renderQuota();
                            origFetch('/sub-status?action=increment', { method: 'POST' }).then(r => r.json()).then(data => {
                                if (!data.allowed) alert('⛔ Bạn đã đạt giới hạn tối đa (' + maxQuota + ' lượt tạo)!');
                                usedQuota = data.usedQuota;
                                renderQuota();
                            }).catch(() => {});
                        }
                    }, true);

                    const savedCsrf = "${db.masterCsrfToken || ''}";
                    window.fetch = function(url, options = {}) {
                        const method = (options.method || 'GET').toUpperCase();
                        const urlStr = String(url);
                        if (method === 'POST' && !urlStr.includes('/sub-status') && maxQuota > 0 && usedQuota > maxQuota) {
                            return Promise.reject(new Error('Đã vượt quá giới hạn số lượt tạo!'));
                        }
                        options.headers = options.headers || {};
                        const csrfCookie = document.cookie.split('; ').find(r => r.startsWith('csrf') || r.startsWith('XSRF'));
                        const token = (csrfCookie ? csrfCookie.split('=')[1] : '') || window.__CSRF_TOKEN__ || savedCsrf;
                        if (token && !(options.headers instanceof Headers)) {
                            options.headers['X-CSRF-Token'] = options.headers['X-CSRF-Token'] || token;
                        }
                        return origFetch(url, options);
                    };

                    const f = ['Tải App', 'Báo lỗi / Góp ý', 'Báo lỗi', 'Vào Nhóm Zalo', 'Gói Vô Hạn', 'Nạp', 'API', 'Lịch sử request', 'Tạo API key', 'Powered by Netlify'];
                    if (${hideHistory}) f.push('Dự án', 'Thư viện');

                    function c() {
                        document.querySelectorAll('a, button, span, div').forEach(el => {
                            const txt = (el.textContent || '').trim();
                            if (!txt || txt.length > 45) return;
                            if (el.children.length === 0 && (txt.toLowerCase() === 'lightvisual' || txt.toLowerCase() === '.studio')) {
                                el.textContent = txt.toLowerCase() === 'lightvisual' ? '${BRAND_NAME}' : '';
                            }
                            if (el.children.length === 0 && /^[0-9\\.]+đ$/i.test(txt)) {
                                const p = el.closest('button, a, div');
                                if (p) p.style.display = 'none';
                                el.style.display = 'none';
                            }
                            if ((el.tagName === 'A' || el.tagName === 'BUTTON' || el.children.length === 0) && f.some(i => txt === i || txt.includes('Vào Nhóm Zalo') || txt.includes('Gói Vô Hạn') || txt.includes('Powered by Netlify'))) {
                                (el.closest('a, button')||el).style.display = 'none';
                            }
                        });
                    }
                    c();
                    new MutationObserver(c).observe(document.documentElement, { childList: true, subtree: true });
                })();
            </script>`;

            return {
                statusCode: response.status,
                headers: { 'content-type': 'text/html; charset=utf-8' },
                body: html.replace('</body>', shield + '</body>')
            };
        }

        const arrayBuffer = await response.arrayBuffer();
        return {
            statusCode: response.status,
            headers: { 'content-type': contentType },
            body: Buffer.from(arrayBuffer).toString('base64'),
            isBase64Encoded: true
        };
    } catch (err) {
        return { statusCode: 502, body: 'Lỗi kết nối Server gốc' };
    }
};
