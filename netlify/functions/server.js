const crypto = require('crypto');
const fs = require('fs');
const querystring = require('querystring');

const TARGET_URL = 'https://lightvisual.studio';
const ADMIN_PASS = 'admin123';
const BRAND_NAME = 'AI Studio Pro';
const SECRET_KEY = 'khoa-bao-mat-proxy-2026-vip';

const DB_FILE = '/tmp/database.json';
let db = {
    masterCookie: '_fbp=fb.1.1791519268646.363735489448337118; llmgw_session=M1Y2NgLnIDTr9nJ21I4RrvOGHLovdiW0pH8-obhseXE',
    masterCsrfToken: '',
    hideHistoryTabs: false,
    lastCreated: null,
    users: {}
};

if (fs.existsSync(DB_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
}
const saveDB = () => {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8'); } catch (e) {}
};

// Hàm tạo chuỗi ngẫu nhiên cho Tài khoản & Mật khẩu
function randomStr(len) {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    let out = '';
    for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}

// Nhận diện tên thiết bị từ trình duyệt của khách
function getDeviceName(ua = '') {
    let os = 'Thiết bị khác';
    if (ua.includes('Windows')) os = '💻 Windows PC';
    else if (ua.includes('Macintosh') || ua.includes('Mac OS')) os = '💻 MacBook/Mac';
    else if (ua.includes('iPhone') || ua.includes('iPad')) os = '📱 iPhone/iPad';
    else if (ua.includes('Android')) os = '📱 Điện thoại Android';

    let browser = 'Trình duyệt';
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

exports.handler = async (event) => {
    const reqPath = event.path || '/';
    const method = event.httpMethod || 'GET';
    const query = event.queryStringParameters || {};
    const cookies = parseCookies(event.headers.cookie || event.headers.Cookie);
    const bodyText = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
    const clientIp = (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || 'Không rõ IP').split(',')[0].trim();
    const userAgent = event.headers['user-agent'] || '';

    // ==========================================
    // 1. TRANG ĐĂNG NHẬP KHÁCH (CHỈ CHO ĐĂNG NHẬP 1 LẦN)
    // ==========================================
    if (reqPath === '/sub-login' && method === 'GET') {
        const errorMsg = query.err || '';
        return {
            statusCode: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Đăng nhập - ${BRAND_NAME}</title><style>body{background:#0b0b0c;color:#fff;font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.box{background:#161618;padding:32px;border-radius:14px;border:1px solid #2a2a2e;width:350px;box-shadow:0 10px 30px rgba(0,0,0,0.6)}h2{margin-top:0;text-align:center;color:#f59e0b}input{width:100%;padding:12px;margin:10px 0;border-radius:8px;border:1px solid #333;background:#0f0f10;color:#fff;box-sizing:border-box}button{width:100%;padding:12px;background:#ea580c;color:#fff;border:none;border-radius:8px;font-weight:bold;cursor:pointer;margin-top:10px}.err{background:rgba(239,68,68,0.15);border:1px solid #ef4444;color:#f87171;padding:10px;border-radius:8px;font-size:13px;text-align:center;margin-bottom:12px}.note{color:#a1a1aa;font-size:12px;text-align:center;margin-top:14px}</style></head><body><div class="box"><h2>${BRAND_NAME}</h2>${errorMsg ? `<div class="err">${errorMsg}</div>` : ''}<form method="POST" action="/sub-login"><input type="text" name="username" placeholder="Tài khoản được cấp" required /><input type="password" name="password" placeholder="Mật khẩu" required /><button type="submit">Đăng Nhập Vào Studio</button></form><div class="note">⚠️ Lưu ý: Mỗi tài khoản chỉ đăng nhập được duy nhất 1 lần trên 1 thiết bị.</div></div></body></html>`
        };
    }

    if (reqPath === '/sub-login' && method === 'POST') {
        const form = querystring.parse(bodyText);
        const username = (form.username || '').trim();
        const password = (form.password || '').trim();
        const user = db.users[username];

        if (!user || user.password !== password) {
            return { statusCode: 302, headers: { Location: '/sub-login?err=' + encodeURIComponent('Sai tài khoản hoặc mật khẩu!') } };
        }

        // KIỂM TRA ĐĂNG NHẬP 1 LẦN DUY NHẤT
        if (user.isUsed) {
            return {
                statusCode: 302,
                headers: { Location: '/sub-login?err=' + encodeURIComponent('Tài khoản này chỉ được đăng nhập 1 lần duy nhất và đã được sử dụng!') }
            };
        }

        const now = Date.now();
        const sessionId = randomStr(12);
        user.isUsed = true; // Khóa ngay sau lần đăng nhập đầu tiên
        user.firstLoginAt = now;
        user.lastActiveAt = now;
        user.sessionId = sessionId;
        user.device = getDeviceName(userAgent);
        user.ip = clientIp;
        saveDB();

        const expireTime = now + user.durationMinutes * 60 * 1000;
        const token = signToken({ username, sessionId, expireTime });
        const maxAgeSec = Math.floor((expireTime - now) / 1000);

        return {
            statusCode: 302,
            headers: {
                'Set-Cookie': `sub_token=${token}; Path=/; HttpOnly; Max-Age=${maxAgeSec}`,
                'Location': '/'
            }
        };
    }

    if (reqPath === '/sub-logout') {
        const msg = query.reason === 'timeout' ? 'Đã hết số phút sử dụng! Bạn đã được đăng xuất tự động.' : 'Bạn đã đăng xuất (Tài khoản 1 lần không thể đăng nhập lại).';
        return {
            statusCode: 302,
            headers: {
                'Set-Cookie': 'sub_token=; Path=/; HttpOnly; Max-Age=0',
                'Location': '/sub-login?err=' + encodeURIComponent(msg)
            }
        };
    }

    // ==========================================
    // 2. TRANG ADMIN QUẢN LÝ (TẠO RANDOM TK/MK THEO PHÚT & XEM MÁY HOẠT ĐỘNG)
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

        // TẠO RANDOM TÀI KHOẢN & MẬT KHẨU CHỈ CẦN NHẬP SỐ PHÚT
        if (reqPath === '/my-admin/random-user' && method === 'POST') {
            const form = querystring.parse(bodyText);
            const mins = parseInt(form.durationMinutes, 10) || 60;
            const randomUsername = 'user_' + Math.floor(1000 + Math.random() * 9000);
            const randomPassword = randomStr(6);

            db.users[randomUsername] = {
                password: randomPassword,
                durationMinutes: mins,
                isUsed: false,
                firstLoginAt: null,
                lastActiveAt: null,
                sessionId: null,
                device: 'Chưa có máy đăng nhập',
                ip: '-',
                usedQuota: 0
            };
            db.lastCreated = { username: randomUsername, password: randomPassword, durationMinutes: mins };
            saveDB();
            return { statusCode: 302, headers: { Location: `/my-admin?pass=${ADMIN_PASS}` } };
        }

        if (reqPath === '/my-admin/delete') {
            delete db.users[query.user];
            saveDB();
            return { statusCode: 302, headers: { Location: `/my-admin?pass=${ADMIN_PASS}` } };
        }

        const now = Date.now();
        const userRows = Object.entries(db.users).reverse().map(([u, info]) => {
            let statusBadge = '<span style="color:#a1a1aa;">⏳ Chưa đăng nhập (Còn nguyên 1 lần)</span>';
            let machineInfo = '<span style="color:#71717a;">Chưa có máy nào vào</span>';

            if (info.isUsed && info.firstLoginAt) {
                const expireTime = info.firstLoginAt + info.durationMinutes * 60000;
                const remainMins = Math.ceil((expireTime - now) / 60000);

                if (remainMins > 0) {
                    statusBadge = `<span style="color:#22c55e;font-weight:bold;">🟢 Đang hoạt động (Còn ${remainMins} phút)</span>`;
                    machineInfo = `<b>${info.device}</b><br><span style="font-size:12px;color:#a1a1aa;">IP: ${info.ip} | Đã khóa 1/1 lần</span>`;
                } else {
                    statusBadge = `<span style="color:#ef4444;font-weight:bold;">🔴 Đã hết giờ (Tự động Out)</span>`;
                    machineInfo = `${info.device} (IP: ${info.ip})`;
                }
            }

            const copyText = `Link: https://${event.headers.host} | TK: ${u} | MK: ${info.password} (${info.durationMinutes} phút)`;

            return `<tr>
                <td><b style="color:#f59e0b;font-size:15px;">${u}</b></td>
                <td><code style="background:#27272a;padding:4px 8px;border-radius:4px;font-size:14px;">${info.password}</code></td>
                <td><b>${info.durationMinutes} phút</b></td>
                <td>${statusBadge}</td>
                <td>${machineInfo}</td>
                <td>
                    <button type="button" onclick="navigator.clipboard.writeText('${copyText}');this.textContent='Đã Copy!';" style="padding:6px 10px;font-size:12px;margin-right:6px;background:#3b82f6;color:#fff;">Copy</button>
                    <a href="/my-admin/delete?pass=${ADMIN_PASS}&user=${u}" style="color:#ef4444;font-weight:bold;text-decoration:none;">Xóa / Đá</a>
                </td>
            </tr>`;
        }).join('');

        const lastCreatedBox = db.lastCreated ? `
            <div style="background:#14532d;border:1px solid #22c55e;padding:14px;border-radius:8px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;">
                <div>
                    ✅ <b>Vừa tạo thành công (${db.lastCreated.durationMinutes} phút):</b> 
                    Tài khoản: <b style="color:#facc15;font-size:16px;">${db.lastCreated.username}</b> | 
                    Mật khẩu: <b style="color:#facc15;font-size:16px;">${db.lastCreated.password}</b>
                </div>
                <button type="button" onclick="navigator.clipboard.writeText('Link: https://${event.headers.host}\\nTài khoản: ${db.lastCreated.username}\\nMật khẩu: ${db.lastCreated.password}\\nThời gian: ${db.lastCreated.durationMinutes} phút (Lưu ý: Chỉ đăng nhập được 1 lần duy nhất)');this.textContent='Đã Copy!';" style="background:#22c55e;color:#000;">📋 Copy gửi khách</button>
            </div>` : '';

        return {
            statusCode: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Admin - ${BRAND_NAME}</title><style>body{background:#0f0f11;color:#e4e4e7;font-family:system-ui,sans-serif;padding:24px;max-width:1050px;margin:auto}.card{background:#18181b;padding:20px;border-radius:10px;border:1px solid #27272a;margin-bottom:22px}input,textarea{width:100%;padding:11px;margin:6px 0 14px;background:#09090b;border:1px solid #3f3f46;color:#fff;border-radius:6px;box-sizing:border-box}button{background:#f59e0b;color:#000;border:none;padding:11px 20px;border-radius:6px;font-weight:bold;cursor:pointer}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{border:1px solid #27272a;padding:10px;text-align:left;font-size:14px}th{background:#27272a}</style></head>
            <body>
                <h2>Quản trị Hệ thống (${BRAND_NAME})</h2>
                
                <div class="card">
                    <h3>🎲 1. Tạo Random Tài khoản & Mật khẩu (Giới hạn 1 lần đăng nhập)</h3>
                    ${lastCreatedBox}
                    <form method="POST" action="/my-admin/random-user?pass=${ADMIN_PASS}" style="display:flex;gap:12px;align-items:center;">
                        <input type="number" name="durationMinutes" placeholder="Nhập số phút cho phép dùng (VD: 60, 120...)" required style="margin:0;flex:1;font-size:15px;" />
                        <button type="submit" style="white-space:nowrap;font-size:15px;">🎲 Bấm Tạo TK Ngẫu Nhiên</button>
                    </form>
                </div>

                <div class="card">
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <h3>🖥️ 2. Danh sách Tài khoản & Máy đang hoạt động</h3>
                        <a href="/my-admin?pass=${ADMIN_PASS}" style="color:#f59e0b;text-decoration:none;font-size:14px;">🔄 Làm mới trạng thái</a>
                    </div>
                    <table>
                        <tr><th>Tài khoản</th><th>Mật khẩu</th><th>Số phút</th><th>Trạng thái hoạt động</th><th>Máy đang dùng / IP</th><th>Thao tác</th></tr>
                        ${userRows || '<tr><td colspan="6" style="text-align:center;color:#71717a;">Chưa có tài khoản nào. Hãy nhập số phút ở mục 1 để tạo!</td></tr>'}
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
            </body></html>`
        };
    }

    // ==========================================
    // 3. KIỂM TRA PHIÊN ĐANG CHẠY & TỰ ĐỘNG ĐÁ VĂNG KHI HẾT GIỜ
    // ==========================================
    const session = verifyToken(cookies.sub_token);
    if (!session || Date.now() > session.expireTime) {
        return {
            statusCode: 302,
            headers: {
                'Set-Cookie': 'sub_token=; Path=/; HttpOnly; Max-Age=0',
                'Location': '/sub-login?err=' + encodeURIComponent('Đã hết số phút sử dụng hoặc phiên đã kết thúc!')
            }
        };
    }

    // Kiểm tra nếu Admin đã bấm Xóa tài khoản này thì đá văng ngay lập tức
    const dbUser = db.users[session.username];
    if (dbUser && dbUser.sessionId && dbUser.sessionId !== session.sessionId) {
        return { statusCode: 302, headers: { Location: '/sub-login?err=' + encodeURIComponent('Phiên đăng nhập không hợp lệ!') } };
    }
    if (dbUser) {
        dbUser.lastActiveAt = Date.now();
    }

    if (reqPath.toLowerCase() === '/app/api' || reqPath.toLowerCase().startsWith('/v1/keys')) {
        return { statusCode: 302, headers: { Location: '/' } };
    }

    // ==========================================
    // 4. CHUYỂN TIẾP LỆNH SANG WEB GỐC & HIỂN THỊ ĐỒNG HỒ ĐẾM NGƯỢC
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

        if (contentType.includes('application/json') && (reqPath.includes('/me') || reqPath.includes('/status') || reqPath.includes('/csrf'))) {
            const jsonText = await response.text();
            try {
                const data = JSON.parse(jsonText);
                const tokenFound = data.csrf_token || data.csrfToken || data.csrf || data?.data?.csrf_token;
                if (tokenFound && tokenFound !== db.masterCsrfToken) {
                    db.masterCsrfToken = tokenFound;
                    saveDB();
                }
            } catch (e) {}
            const outHeaders = { 'content-type': contentType };
            if (resCsrf) outHeaders['x-csrf-token'] = resCsrf;
            return { statusCode: response.status, headers: outHeaders, body: jsonText };
        }

        if (contentType.includes('text/html')) {
            let html = await response.text();
            html = html.replace(/lightvisual\.studio/gi, BRAND_NAME).replace(/lightvisual/gi, BRAND_NAME);
            const remainSec = Math.max(0, Math.floor((session.expireTime - Date.now()) / 1000));
            const hideHistory = db.hideHistoryTabs ? 'true' : 'false';

            const shield = `<style>
                a[href*="/api"], a[href*="zalo.me"], a[href*="pricing"], a[href*="billing"], a[href*="netlify.com"], iframe[src*="netlify"] { display: none !important; }
                #custom-timer-bar {
                    position: fixed; top: 8px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
                    background: #161618; border: 1px solid #f59e0b;
                    color: #fff; padding: 6px 16px; border-radius: 99px;
                    font-family: system-ui, sans-serif; font-size: 13px;
                    box-shadow: 0 4px 20px rgba(0,0,0,0.85); white-space: nowrap;
                }
            </style>
            <div id="custom-timer-bar">
                👤 <b>${session.username}</b> | ⏳ Còn lại: <b id="time-left-val" style="color:#f59e0b;">--:--</b> | <a href="/sub-logout" style="color:#ef4444;font-weight:bold;text-decoration:none;margin-left:8px;">Thoát</a>
            </div>
            <script>
                (function(){
                    const savedCsrf = "${db.masterCsrfToken || ''}";
                    const origFetch = window.fetch;
                    window.fetch = function(url, options = {}) {
                        options.headers = options.headers || {};
                        const csrfCookie = document.cookie.split('; ').find(r => r.startsWith('csrf') || r.startsWith('XSRF'));
                        const token = (csrfCookie ? csrfCookie.split('=')[1] : '') || window.__CSRF_TOKEN__ || savedCsrf;
                        if (token && !(options.headers instanceof Headers)) {
                            options.headers['X-CSRF-Token'] = options.headers['X-CSRF-Token'] || token;
                        }
                        return origFetch(url, options).then(async res => {
                            try {
                                const clone = res.clone();
                                const data = await clone.json();
                                if (data && (data.csrf_token || data.csrfToken || data.csrf)) {
                                    window.__CSRF_TOKEN__ = data.csrf_token || data.csrfToken || data.csrf;
                                }
                            } catch(e) {}
                            return res;
                        });
                    };

                    // Đếm ngược & Tự động văng ra ngoài khi hết số phút
                    let sec = ${remainSec};
                    const t = document.getElementById('time-left-val');
                    setInterval(() => {
                        sec--;
                        if (sec <= 0) {
                            window.location.href = '/sub-logout?reason=timeout';
                        }
                        if (t && sec >= 0) {
                            t.textContent = Math.floor(sec/60) + 'p ' + (sec%60 < 10 ? '0' : '') + (sec%60) + 's';
                        }
                    }, 1000);

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
                                (el.closest('a, button') || el).style.display = 'none';
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
        const outHeaders = { 'content-type': contentType };
        if (resCsrf) outHeaders['x-csrf-token'] = resCsrf;
        return {
            statusCode: response.status,
            headers: outHeaders,
            body: Buffer.from(arrayBuffer).toString('base64'),
            isBase64Encoded: true
        };
    } catch (err) {
        return { statusCode: 502, body: 'Lỗi kết nối Server gốc' };
    }
};
