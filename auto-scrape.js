/**
 * Binance 网格机器人 自动定时抓取 v4
 * 
 * 功能：
 *   - 每 N 分钟自动刷新页面 → 切换到「机器人」tab → 抓取数据
 *   - 固定输出文件名（覆盖），同时生成手机友好格式
 *   - 通过 columns.conf 配置保留哪些列
 *   - 抓取后通过 Bark App 推送到手机
 *
 * 前提：Edge 以 --remote-debugging-port=9222 启动
 * 用法：node.exe auto-scrape.js
 *       node.exe auto-scrape.js --interval 10    (每10分钟)
 *       node.exe auto-scrape.js --bark <key>      (Bark推送key，或写在 .env 里)
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');

// ===== 配置 =====
const CDP_URL = 'http://localhost:9222';
const OUTPUT_DIR = path.join(__dirname, 'output');
const CONF_FILE = path.join(__dirname, 'columns.conf');  // 列配置
const ENV_FILE  = path.join(__dirname, '.env');          // Bark key 等

// 固定输出文件名（每次覆盖）
const OUT_CSV = path.join(OUTPUT_DIR, 'grid_bots.csv');
const OUT_TXT = path.join(OUTPUT_DIR, 'grid_bots.txt');  // 手机友好文本

const INTERVAL_MS = parseInterval();
const MAX_WAIT_MS = 30000;

// ===== 全部可用列（固定顺序）=====
const ALL_HEADERS = [
    '抓取时间', '当前币价',
    '合约', '方向', '杠杆', '日期', '时间',
    '已投保证金', '保证金类型', '总收益', '收益率',
    '资金费用', '费率', '已配对利润', '配对收益率',
    '未配对盈亏', '未配对率', '配对次数',
    '价格区间下限', '价格区间上限', '网格数量', '每笔数量',
    '止盈价', '止损价', '运行时间', '强平价格',
    '网格状态', '风险率'
];

let runCount = 0;
let activeHeaders;       // 用户启用的列
let barkKey;             // Bark推送 key

// ================================================================
// 启动 & 主循环
// ================================================================

async function main() {
    // 加载配置
    activeHeaders = loadColumnConfig(CONF_FILE);
    barkKey = loadEnv('BARK_KEY');

    console.log('╔═════════════════════════════════════════════════╗');
    console.log('║  🤖 Binance 网格机器人 自动定时抓取 v4         ║');
    console.log(`║  ⏱️  间隔: ${(INTERVAL_MS/60000).toFixed(0)} 分钟                              ║`);
    console.log(`║  📋  启用列: ${activeHeaders.length}/${ALL_HEADERS.length}                            ║`);
    console.log(`║  📲  推送: ${barkKey ? '✅ 已配置' : '❌ 未配置'}                              ║`);
    console.log('║  按 Ctrl+C 停止                               ║');
    console.log('╚═════════════════════════════════════════════════╝\n');

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    // 立即执行第一次
    await scrapeOnce();

    // 定时循环（用 async loop 避免 setInterval 积压）
    while (true) {
        await sleep(INTERVAL_MS);
        scrapeOnce().catch(err => console.error('❌ 定时抓取失败:', err.message));
    }
}

// ================================================================
// 单次抓取流程
// ================================================================

async function scrapeOnce() {
    runCount++;
    const now = new Date();
    const nowStr = formatDatetime(now);

    console.log(`\n${'─'.repeat(55)}`);
    console.log(`▶ 第 ${runCount} 次抓取  ${nowStr}`);
    console.log(`${'─'.repeat(55)}`);

    let browser;
    try {
        browser = await chromium.connectOverCDP(CDP_URL);
        const page = browser.contexts()[0].pages()[0];

        // 1. 刷新页面
        console.log('🔄 刷新页面...');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: MAX_WAIT_MS });
        await page.waitForTimeout(2000);

        // 2. 点击「机器人」tab
        console.log('🔘 切换到「机器人」标签...');
        const clicked = await page.evaluate(() => {
            const tabs = document.querySelectorAll('[role="tab"]');
            for (const tab of tabs) {
                if ((tab.innerText || '').trim() === '机器人') {
                    tab.click(); return true;
                }
            }
            const all = [...document.querySelectorAll('.bn-tab')];
            const botTab = all.find(el => (el.innerText || '').trim() === '机器人');
            if (botTab) { botTab.click(); return true; }
            return false;
        });

        if (!clicked) {
            console.log('⚠️ 未找到「机器人」tab');
        } else {
            console.log('✅ 已切换');
            await page.waitForTimeout(2000);  // 等表格渲染
        }

        // 3. 提取数据（带稳定性校验）
        let bots = await extractBots(page);
        if (bots.length > 0) {
            // 等待1秒后再次提取，对比数据是否稳定
            await page.waitForTimeout(1000);
            const bots2 = await extractBots(page);
            
            if (bots2.length > 0 && !isDataStable(bots, bots2)) {
                console.log('⚠️ 数据不稳定，等待重新加载...');
                await page.waitForTimeout(2000);
                const bots3 = await extractBots(page);
                if (bots3.length > 0) bots = bots3;
                else console.log('⚠️ 第三次仍不稳定，使用首次数据');
            }
        }

        // 3b. 抓取页面当前币价（标记价格）
        const coinPrice = await extractCoinPrice(page);

        if (bots.length === 0) {
            console.log('⚠️ 未抓取到数据');
        } else {
            // 注入抓取时间 + 币价
            bots.forEach(b => { 
                b['抓取时间'] = nowStr; 
                b['当前币价'] = coinPrice || '';
            });

            // 4a. 写 CSV（固定文件名，覆盖）
            writeCSV(bots, OUT_CSV);
            console.log(`💾 CSV: ${path.basename(OUT_CSV)} (${activeHeaders.length}列 × ${bots.length}行)`);

            // 4b. 写手机友好 TXT（固定文件名，覆盖）
            const pushData = formatPhoneText(bots);
            fs.writeFileSync(OUT_TXT, pushData.body, 'utf-8');
            console.log(`📱 TXT: ${path.basename(OUT_TXT)}`);

            // 5. 终端预览
            printPreview(bots);

            // 6. Bark 推送
            if (barkKey) {
                await sendBark(barkKey, pushData);
            }
        }

        // 下次时间
        const nextTime = new Date(Date.now() + INTERVAL_MS);
        console.log(`\n⏰ 下次: ${formatDatetime(nextTime)}`);

    } catch (err) {
        console.error(`❌ 抓取失败: ${err.message}`);
        if (err.message.includes('connect')) {
            console.error('   → 请确认 Edge 已以 --remote-debugging-port=9222 启动');
        }
    } finally {
        if (browser) { try { await browser.close(); } catch {} }
    }
}

// ================================================================
// 数据提取（同 extract-grid-table.js 逻辑）
// ================================================================

async function extractBots(page) {
    const lines = await page.evaluate(() => {
        return document.body.innerText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    });

    // 找表头
    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i] === '合约') {
            const ahead = lines.slice(i + 1, i + 4).join('');
            if (ahead.includes('时间') && ahead.includes('已投保证金')) {
                headerIdx = i; break;
            }
        }
    }
    if (headerIdx < 0) return [];

    // 分组
    const dataStart = headerIdx + 17;
    const groups = [];
    for (let i = dataStart; i < lines.length; i++) {
        const line = lines[i];
        if (/Cookie|活动中心|公告|风险揭示|合约交流房/.test(line)) break;
        if (/(ETH|BTC|SOL|DOGE|XRP|BNB)\w*\s*永续/.test(line)) groups.push([]);
        if (groups.length > 0) groups[groups.length - 1].push(line);
        if (groups.length >= 20) break;
    }

    const bots = [];
    for (let g = 0; g < groups.length; g++) {
        if (groups[g].length < 10) continue;
        const b = parseOneBot(groups[g], g + 1);
        if (b) bots.push(b);
    }
    return bots;
}

/**
 * 从页面提取当前币价（标记价格）
 * Binance 网格交易页面顶部显示 "标记价格 2,304.81"
 */
async function extractCoinPrice(page) {
    try {
        const price = await page.evaluate(() => {
            // 策略1：从 ticker-market-list 区域提取标记价格
            // DOM结构：div.ticker-market-list 里包含 "标记价格\r\n2,304.81"
            const tickerEl = document.querySelector('[class*="ticker-market"]') 
                          || document.querySelector('[class*="market-list"]');
            if (tickerEl) {
                const text = tickerEl.innerText;
                // 匹配 "标记价格" 后面跟着的数字（可能跨行）
                const m = text.match(/标记价格[\s\r\n]*([\d,]+\.?\d*)/);
                if (m) return m[1];
            }

            // 策略2：全文搜索（处理跨行的标记价格）
            const allText = document.body.innerText;
            const m2 = allText.match(/标记价格[\s\r\n]*([\d,]+\.?\d*)/);
            if (m2) return m2[1];

            // 策略3：找 "最新价" 或 "最新价格" 附近的数字
            const m3 = allText.match(/最新价(?:格)?[\s\r\n]*([\d,]+\.?\d*)/);
            if (m3) return m3[1];

            return '';
        });
        console.log(`💰 币价: ${price || '(未抓到)'}`);
        return price;
    } catch (e) {
        console.log(`⚠️ 币价抓取失败: ${e.message}`);
        return '';
    }
}

/**
 * 比较两次抓取数据是否稳定（核心字段一致）
 * 防止页面渲染中途读取到不完整/缓存数据
 */
function isDataStable(bots1, bots2) {
    if (bots1.length !== bots2.length) return false;
    
    for (let i = 0; i < bots1.length; i++) {
        const a = bots1[i];
        const b = bots2[i];
        // 对比关键字段：总收益、已投保证金、收益率
        if (a['总收益'] !== b['总收益']) return false;
        if (a['已投保证金'] !== b['已投保证金']) return false;
        if (a['收益率'] !== b['收益率']) return false;
        // 合约名和方向也应该一致
        if (a['合约'] !== b['合约']) return false;
    }
    
    return true;
}

function parseOneBot(rawLines, _botNum) {
    if (!rawLines || rawLines.length < 15) return null;
    const b = {};
    let i = 0;

    const contractLine = rawLines[i++] || '';
    const cm = contractLine.match(/((?:ETH|BTC|SOL|DOGE|XRP|BNB)\w*)\s*永续/);
    b['合约'] = cm ? cm[1] : contractLine;

    const dl = rawLines[i++] || '';
    b['方向'] = dl.match(/(中性|做多|做空)/)?.[1] || '';
    const lm = dl.match(/(\d+x)/)?.[1];
    b['杠杆'] = (lm || '') + (dl.includes('移动') ? ' 移动' : '');

    const dateL = rawLines[i++] || '';
    const timeL = rawLines[i++] || '';
    if (/\d{4}-\d{2}-\d{2}/.test(dateL)) {
        b['日期'] = dateL.trim(); b['时间'] = timeL.trim();
    } else {
        const dtm = dateL.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
        if (dtm) { b['日期'] = dtm[1]; b['时间'] = dtm[2]; i--; }
    }

    const marginVal = rawLines[i++] || '';
    const marginType = rawLines[i++] || '';
    const mv = marginVal.match(/([\d,]+\.?\d*)/);
    b['已投保证金'] = mv ? mv[1] : marginVal;
    b['保证金类型'] = marginType.replace(/[()]/g, '').trim();

    b['总收益']   = safeUSDC(rawLines[i++]);
    b['收益率']   = safePct(rawLines[i++]);
    b['资金费用'] = safeUSDC(rawLines[i++]);
    b['费率']     = safePct(rawLines[i++]);
    b['已配对利润'] = safeUSDC(rawLines[i++]);
    b['配对收益率'] = safePct(rawLines[i++]);
    b['未配对盈亏'] = safeUSDC(rawLines[i++]);
    b['未配对率']   = safePct(rawLines[i++]);
    b['配对次数'] = (rawLines[i++] || '').match(/\d+/)?.[0] || '';

    const pLo = (rawLines[i++] || '').replace(/[-\s]/g, '').trim();
    const pHi = (rawLines[i++] || '').trim();
    b['价格区间下限'] = pLo; b['价格区间上限'] = pHi;
    b['网格数量'] = (rawLines[i++] || '').match(/\d+/)?.[0] || '';

    const amt = rawLines[i++] || '';
    const am = amt.match(/([\d,]+\.?\d*)/);
    b['每笔数量'] = am ? am[1] + (amt.includes('ETH') ? ' ETH' : ' USDC') : amt;

    b['止盈价'] = (rawLines[i++] || '').replace(/[/\s]/g, '').trim();
    b['止损价'] = (rawLines[i++] || '').trim();
    b['运行时间'] = (rawLines[i++] || '').trim();
    b['强平价格'] = (rawLines[i++] || '').trim();

    const statusLine = rawLines[i++] || '';
    b['网格状态'] = statusLine.includes('运行中') ? '运行中'
                  : statusLine.includes('已停止') ? '已停止' : statusLine.trim();

    const riskLine = rawLines[i++] || '';
    const rm = riskLine.match(/(\d+\.?\d*)\s*(低|中|高)风险/);
    b['风险率'] = rm ? `${rm[1]} (${rm[2]})` : riskLine.trim();

    return !b['合约'] || !b['已投保证金'] ? null : b;
}

// ================================================================
// 输出：CSV（只写启用列）
// ================================================================

function writeCSV(bots, filePath) {
    const esc = v => {
        const s = String(v ?? '');
        return /[,"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
        '\uFEFF' + activeHeaders.map(esc).join(','),
        ...bots.map(bot => activeHeaders.map(h => esc(bot[h] ?? '')).join(','))
    ];
    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

// ================================================================
// 输出：手机友好文本格式
// ================================================================

/**
 * 生成推送文本（模板引擎）
 * 
 * 从 push-template.txt 读取排版模板，替换占位符为实际数据
 * 用户只需编辑 push-template.txt 即可自定义格式
 * 
 * 返回: { title: string, body: string }
 */
const TEMPLATE_FILE = path.join(__dirname, 'push-template.txt');

function formatPhoneText(bots) {
    const ts = new Date();
    const tStr = `${ts.getHours()}:${String(ts.getMinutes()).padStart(2,'0')}`;

    // 计算总收益
    let totalPnL = 0;
    bots.forEach(b => {
        const m = (b['总收益'] || '').match(/([+-]?[\d,]+\.?\d*)/);
        totalPnL += parseFloat(m?.[1] || 0);
    });

    // 特殊变量
    const vars = {
        '{时间}': tStr,
        '{总收益汇总}': `${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}`,
        '{机器人数量}': String(bots.length),
        '{正负符号}': totalPnL >= 0 ? '🟢' : '🔴',
        '{当前币价}': bots.length > 0 ? (bots[0]['当前币价'] || '') : '',
    };

    // 读取模板文件（不存在则使用内置默认）
    let template;
    if (fs.existsSync(TEMPLATE_FILE)) {
        template = fs.readFileSync(TEMPLATE_FILE, 'utf8');
    } else {
        template = `title:🤖 {正负符号}{总收益汇总}\n{each_bot}{序号} {合约} 收益:{总收益}\n{end_each_bot}`;
    }

    const lines = template.split('\n');
    const output = [];
    let titleFromTemplate = '';  // 从 title: 行提取

    for (let li = 0; li < lines.length; li++) {
        let line = lines[li];

        // 跳过注释行
        if (line.trim().startsWith('#')) continue;

        // 提取 title: 行（只取第一个）
        if (!titleFromTemplate && line.trim().startsWith('title:')) {
            titleFromTemplate = line.trim().replace(/^title:\s*/, '');
            continue;
        }

        // 处理 {每个机器人}...{结束} 循环块
        if (line.includes('{每个机器人}') || line.includes('{结束}')) {
            // 收集循环块的所有行
            const blockLines = [];
            while (li < lines.length && !lines[li].includes('{结束}')) {
                let bl = lines[li];
                if (!bl.trim().startsWith('#') && !bl.includes('{每个机器人}')) {
                    blockLines.push(bl);
                }
                li++;
            }
            
            // 对每个机器人渲染一遍
            bots.forEach((b, idx) => {
                const botVars = { ...vars, '{序号}': String(idx + 1) };
                
                for (const bl of blockLines) {
                    let rendered = bl;
                    // 先替换特殊变量和列名变量
                    for (const [k, v] of Object.entries(botVars)) {
                        rendered = rendered.replaceAll(k, v);
                    }
                    // 替换所有列名占位符（按长名字优先排序避免子串冲突）
                    const sortedKeys = [...activeHeaders].sort((a, b) => b.length - a.length);
                    for (const h of sortedKeys) {
                        rendered = rendered.replaceAll(`{${h}}`, b[h] || '');
                    }
                    
                    output.push(rendered);
                }
            });
            continue;
        }

        // 普通行：跳过空行，替换变量
        if (line.trim() === '') continue;

        for (const [k, v] of Object.entries(vars)) {
            line = line.replaceAll(k, v);
        }
        // 替换列名占位符
        const sortedKeys = [...activeHeaders].sort((a, b) => b.length - a.length);
        for (const h of sortedKeys) {
            line = line.replaceAll(`{${h}}`, '');
        }
        
        output.push(line);
    }

    return { 
        title: renderVars(titleFromTemplate || '🤖 网格', vars), 
        body: output.join('\n') 
    };
}

/** 简单的变量渲染（用于标题） */
function renderVars(str, vars) {
    let result = str;
    for (const [k, v] of Object.entries(vars)) {
        result = result.replaceAll(k, v);
    }
    return result;
}

// ================================================================
// Bark 推送
// ================================================================

/**
 * 通过 Bark API 推送到 iPhone
 *
 * Bark API 官方格式（GET）：
 *   https://api.day.app/:key/:title/:body?group=xxx&sound=default
 *
 * body 在路径中，换行用 %0A 编码
 */
function sendBark(key, pushData) {
    return new Promise((resolve) => {
        const title = pushData.title;
        const bodyText = pushData.body;

        // Bark 路径格式：/:key/:title/:body
        const encTitle = encodeURIComponent(title);
        const encBody = encodeURIComponent(bodyText);
        const urlStr = `https://api.day.app/${key}/${encTitle}/${encBody}?group=binance-bots&sound=default&isArchive=1`;

        console.log(`📲 推送 Bark... (title="${title}", body=${bodyText.length}字)`);

        const req = https.get(urlStr, { timeout: 15000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                console.log(`   响应(${res.statusCode}): ${data.slice(0, 300)}`);
                if (res.statusCode === 200 && data.includes('"code":200')) {
                    console.log(`✅ 推送成功`);
                } else {
                    console.log(`⚠️ 可能失败`);
                }
                resolve();
            });
        });

        req.on('error', err => {
            console.log(`⚠️ 网络错误: ${err.message}`);
            resolve();
        });
        req.setTimeout(15000, () => { req.destroy(); console.log('⚠️ 超时'); resolve(); });
    });
}

// ================================================================
// 配置加载
// ================================================================

/**
 * 从 columns.conf 读取列开关配置
 * 格式：每行 "列名=y" 或 "列名=n"
 * 返回启用的列名数组（保持 ALL_HEADERS 原始顺序）
 */
function loadColumnConfig(confPath) {
    const defaults = ALL_HEADERS.filter(() => true);  // 全部启用作为默认

    if (!fs.existsSync(confPath)) {
        console.log(`📝 未找到 ${path.basename(confPath)}，使用全部列`);
        return defaults;
    }

    const raw = fs.readFileSync(confPath, 'utf-8');
    const enabled = {};

    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const name = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim().toLowerCase();
        if (name && (val === 'y' || val === 'yes' || val === '1')) {
            enabled[name] = true;
        }
    }

    // 按 ALL_HEADERS 顺序过滤，保证列序稳定
    const result = ALL_HEADERS.filter(h => enabled[h]);

    if (result.length === 0) {
        console.log(`⚠️ columns.conf 中没有启用任何列，使用默认全开`);
        return defaults;
    }

    console.log(`📋 已加载列配置: ${result.join(', ')}`);
    return result;
}

/**
 * 从 .env 文件读取环境变量
 */
function loadEnv(key) {
    // 优先级：命令行参数 > .env 文件
    const cliIdx = process.argv.indexOf('--bark');
    if (cliIdx !== -1 && process.argv[cliIdx + 1]) {
        return process.argv[cliIdx + 1];
    }

    if (!fs.existsSync(ENV_FILE)) return null;

    const raw = fs.readFileSync(ENV_FILE, 'utf-8');
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const k = trimmed.slice(0, eqIdx).trim();
        const v = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        if (k === key) return v;
    }
    return null;
}

// ================================================================
// 工具函数 & 预览
// ================================================================

function printPreview(bots) {
    bots.forEach((b, idx) => {
        const margin = b['已投保证金'] || '';
        const profit = b['总收益'] || '';
        const pct    = b['收益率'] || '';
        const arrow  = profit.startsWith('+') ? '📈' : profit.startsWith('-') ? '📉' : '➖';
        console.log(`  ${arrow} #${idx+1} ${(b['合约']||'').padEnd(12)} ${(b['方向']||'').padEnd(3)} ${(b['杠杆']||'').padEnd(8)} 保${margin.padEnd(8)} ${profit} (${pct})  ${b['运行时间']||''}`);
    });
}

function safeUSDC(str) {
    const s = str || '';
    const m = s.match(/([+-]?[\d,]+\.?\d*)/);
    return m ? m[1] : s.replace(/[()]/g, '').trim();
}

function safePct(str) {
    const s = str || '';
    const m = s.match(/([+-]?[\d,]*\.?\d*)%/);
    return m ? m[0] : (/\d/.test(s) ? s.trim() : '');
}

function formatDatetime(d) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function parseInterval() {
    const idx = process.argv.indexOf('--interval');
    if (idx !== -1 && process.argv[idx + 1]) {
        const min = parseInt(process.argv[idx + 1], 10);
        if (!isNaN(min) && min > 0) return min * 60 * 1000;
    }
    return 5 * 60 * 1000;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===== 优雅退出 =====
process.on('SIGINT', () => {
    console.log(`\n\n👋 已停止。共执行 ${runCount} 次抓取。`);
    process.exit(0);
});

main().catch(e => { console.error('❌ 启动失败:', e.message); process.exit(1); });
