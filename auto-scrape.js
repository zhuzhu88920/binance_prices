/**
 * Binance 网格机器人 自动定时抓取 v5
 * 
 * 功能：
 *   - 每 N 分钟自动切 tab 刷新 → 切回「机器人」tab → 抓取数据
 *   - 用「仓位→机器人」tab 切替代整页 reload（更轻量更稳定）
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
    console.log('║  🤖 Binance 网格机器人 自动定时抓取 v5         ║');
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

        // 遍历所有 context 和 page，找到 binance.com 的页面
        let page = null;
        const allPages = [];
        for (const ctx of browser.contexts()) {
            for (const p of ctx.pages()) {
                allPages.push(p);
            }
        }
        console.log(`🔍 检测到 ${allPages.length} 个页面:`);
        for (const p of allPages) {
            const u = p.url();
            console.log(`   - ${u.slice(0, 80)}`);
            if (!page && u.includes('binance.com')) {
                page = p;
            }
        }
        if (!page) {
            // 兜底：取第一个非 devtools 页面
            page = allPages.find(p => !p.url().startsWith('devtools://')) || allPages[0];
            console.log(`⚠️ 未找到 binance.com 页面，使用: ${page?.url()?.slice(0, 80)}`);
        } else {
            console.log(`✅ 使用 Binance 页面: ${page.url().slice(0, 80)}`);
        }
        if (!page) throw new Error('没有可用的页面，请确认 Edge 已打开 Binance');

        // 1. 切 tab 刷新数据（替代整页 reload，更轻量更稳定）
        //    先切到「仓位」tab，再切回「机器人」tab，触发表格数据重新拉取
        console.log('🔄 切换标签刷新数据...');
        const switchResult = await switchTabToRefresh(page);

        if (switchResult === 'fallback_reload') {
            // tab 切换失败，退回整页 reload
            console.log('⚠️ tab 切换失败，回退到整页刷新...');
            await page.reload({ waitUntil: 'domcontentloaded', timeout: MAX_WAIT_MS });
            await page.waitForTimeout(2000);
            // 刷新后需要点击机器人 tab
            await clickTab(page, '机器人');
        }

        // 2. 提取数据（带稳定性校验）
        let bots = await extractBots(page);
        if (bots.length > 0) {
            // tab 切换后数据是实时 WebSocket 推送的，短时间内金额可能有微小变动
            // 所以稳定性校验只对比"机器人数量 + 合约名 + 方向"这些不会变的字段
            await page.waitForTimeout(1000);
            const bots2 = await extractBots(page);
            
            if (bots2.length !== bots.length) {
                // 数量变了才说明数据可能还没加载完
                console.log('⚠️ 数据不稳定（数量变化），等待重新加载...');
                await page.waitForTimeout(2000);
                const bots3 = await extractBots(page);
                if (bots3.length > 0) bots = bots3;
                else console.log('⚠️ 第三次仍不稳定，使用首次数据');
            } else {
                // 数量一致，用第二次数据（更新鲜）
                bots = bots2;
            }
        }

        // 2b. 抓取页面当前币价（标记价格）
        const coinPrice = await extractCoinPrice(page);

        if (bots.length === 0) {
            console.log('⚠️ 未抓取到数据');
        } else {
            // 注入抓取时间 + 币价
            bots.forEach(b => { 
                b['抓取时间'] = nowStr; 
                b['当前币价'] = coinPrice || '';
            });

            // 3a. 写 CSV（固定文件名，覆盖）
            writeCSV(bots, OUT_CSV);
            console.log(`💾 CSV: ${path.basename(OUT_CSV)} (${activeHeaders.length}列 × ${bots.length}行)`);

            // 3b. 写手机友好 TXT（固定文件名，覆盖）
            const pushData = formatPhoneText(bots);
            fs.writeFileSync(OUT_TXT, pushData.body, 'utf-8');
            console.log(`📱 TXT: ${path.basename(OUT_TXT)}`);

            // 4. 终端预览
            printPreview(bots);

            // 5. Bark 推送
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
// Tab 切换刷新（替代整页 reload）
// ================================================================

/**
 * 点击指定名称的 tab
 * 支持前缀匹配：传入"仓位"可匹配"仓位(0)"这种动态文本
 * @param {import('playwright').Page} page
 * @param {string} tabName - tab 名称，如 "机器人"、"仓位"
 * @returns {Promise<boolean>} 是否成功点击
 */
async function clickTab(page, tabName) {
    const clicked = await page.evaluate((name) => {
        const tabs = document.querySelectorAll('[role="tab"]');
        for (const tab of tabs) {
            const text = (tab.innerText || '').trim();
            // 精确匹配 或 前缀匹配（处理 "仓位(0)" 这种带数字的情况）
            if (text === name || text.startsWith(name + '(') || text.startsWith(name + '（')) {
                tab.click(); return true;
            }
        }
        // 兜底：.bn-tab 类
        const all = [...document.querySelectorAll('.bn-tab')];
        for (const el of all) {
            const text = (el.innerText || '').trim();
            if (text === name || text.startsWith(name + '(') || text.startsWith(name + '（')) {
                el.click(); return true;
            }
        }
        return false;
    }, tabName);
    return !!clicked;
}

/**
 * 通过切换 tab 来刷新表格数据
 *
 * 策略：切到「仓位」tab → 等 800ms → 切回「机器人」tab → 等渲染
 * 比整页 reload 更轻量，不会断开 WebSocket，不会重载全部资源。
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<string>} 'ok' 成功 | 'fallback_reload' 需要回退到 reload
 */
async function switchTabToRefresh(page) {
    // Step 1: 切到「仓位」tab
    console.log(`  🔘 切到「仓位」...`);
    const toPos = await clickTab(page, '仓位');
    if (!toPos) {
        console.log(`  ⚠️ 未找到「仓位」tab`);
        return 'fallback_reload';
    }

    // 在仓位 tab 停留一小会（让 SPA 触发 tab 切换逻辑）
    await page.waitForTimeout(800);

    // Step 2: 切回「机器人」tab
    console.log(`  🔘 切回「机器人」...`);
    const toBot = await clickTab(page, '机器人');
    if (!toBot) {
        console.log(`  ⚠️ 未找到「机器人」tab`);
        return 'fallback_reload';
    }

    console.log('✅ 已通过 tab 切换刷新数据');
    // 等表格重新渲染（比 reload 后的等待时间更短，因为是局部更新）
    await page.waitForTimeout(1500);
    return 'ok';
}

// ================================================================
// 数据提取（基于 DOM 表格直接读取）
// ================================================================
//
// Binance 使用 role="table" 的虚拟滚动表格 (bn-virtual-table-wrapper)
// 表头: [role="columnheader"] → th 或 .bn-table-header
// 数据行: [role="row"]，每个单元格 [role="cell"] 内部用 " | " 分隔子字段
//
// 实际表头列（探测确认）:
//   0:合约 | 1:时间 | 2:已投保证金 | 3:总收益 | 4:资金费用
//   5:已配对利润 | 6:未配对盈亏 | 7:总配对次数 | 8:价格区间
//   9:网格数量 | 10:每笔数量 | 11:止盈/止损 | 12:运行时间
//   13:强平价格 | 14:网格状态 | 15:机器人风险率 | 16:操作
//

/**
 * 从 DOM 表格中直接提取机器人数据
 * 返回 [{ 合约, 方向, 杠杆, 已投保证金, 总收益, ... }, ...]
 */
async function extractBots(page) {
    const rawData = await page.evaluate(() => {
        // 找表格容器
        const table = document.querySelector('[role="table"]');
        if (!table) return { error: '未找到 role=table 元素' };

        // 提取表头
        const headerEls = table.querySelectorAll('th, [role="columnheader"], thead tr > *');
        const headers = [];
        headerEls.forEach(h => {
            const text = h.innerText.trim();
            if (text) headers.push(text);
        });

        // 如果标准表头没找到，尝试从第一行数据行的 cell 索引推断
        // （Binance 有时表头不是 th 而是 div）
        if (headers.length === 0) {
            const firstRow = table.querySelector('[role="row"]');
            if (firstRow) {
                firstRow.querySelectorAll(':scope > *, td, [role="cell"], .bn-virtual-table-cell').forEach(() => {
                    headers.push(''); // 占位，后面映射
                });
            }
        }

        // 提取所有数据行
        const rows = [];
        table.querySelectorAll('tbody tr, [role="row"]:not([aria-label])').forEach(tr => {
            const cells = [];
            tr.querySelectorAll('td, [role="cell"], .bn-virtual-table-cell').forEach(td => {
                cells.push(td.innerText.trim().replace(/\s+/g, ' ').trim());
            });

            // 跳过表头行（如果表头混在 row 里面）和空行
            // 表头行特征：第一个单元格是"合约"
            if (cells.length >= 5 && cells[0] !== '合约') {
                rows.push(cells);
            }
        });

        return { headers, rows };
    });

    if (rawData.error) {
        console.log(`🔍 [DEBUG] ${rawData.error}`);
        return [];
    }

    if (rawData.rows.length === 0) {
        console.log(`🔍 [DEBUG] 找到表格但没有数据行。headers=${JSON.stringify(rawData.headers)}`);
        return [];
    }

    console.log(`📊 表格: ${rawData.rows.length} 个机器人`);

    // 将每行原始单元格解析为结构化机器人对象
    const bots = [];
    for (let r = 0; r < rawData.rows.length; r++) {
        const bot = parseOneBotFromCells(rawData.rows[r], r);
        if (bot) bots.push(bot);
        else console.log(`🔍 [DEBUG] 第${r+1}行解析失败: ${rawData.rows[r].slice(0,3).join(' ||| ')}`);
    }

    return bots;
}

/**
 * 从一行单元格数组解析为机器人对象
 * 
 * 单元格格式（每个 cell 内部可能包含多个字段用 " | " 分隔）：
 *   cell[0] "ETHUSDC | 永续|中性 20x|移动"     → 合约 + 类型 + 方向 + 杠杆
 *   cell[1] "2026-04-27 | 18:47:23"             → 日期 + 时间
 *   cell[2] "1,000.00 USDC | (逐仓)"            → 已投保证金 + 保证金类型
 *   cell[3] "+8.33 USDC | +0.83%"               → 总收益 + 收益率
 *   cell[4] "+0.54 USDC | +0.05%"               → 资金费用 + 费率
 *   cell[5] "+71.77 USDC | +7.17%"              → 已配对利润 + 配对收益率
 *   cell[6] "-63.99 USDC | -6.39%"              → 未配对盈亏 + 未配对率
 *   cell[7] "214"                                → 配对次数
 *   cell[8] "2266.25 - | 2345.80"               → 价格区间下限 + 上限
 *   cell[9] "40"                                 → 网格数量
 *   cell[10] "390.24390 USDC"                    → 每笔数量
 *   cell[11] "-- / | --"                         → 止盈价 + 止损价
 *   cell[12] "22时 51分"                          → 运行时间
 *   cell[13] "1,750.30"                           → 强平价格
 *   cell[14] "运行中"                             → 网格状态
 *   cell[15] "2.5 低风险"                         → 风险率
 */
function parseOneBotFromCells(cells, _rowNum) {
    if (!cells || cells.length < 10) return null;

    const b = {};
    const splitCell = (idx) => (cells[idx] || '').split(/\s*\|\s*/).map(s => s.trim());

    /**
     * 解析 "金额+百分比" 格式的 cell
     * 实际格式: "+3.81 USDC +0.38%" 或 "+3.81 USDC\n+0.38%"
     * 返回 [金额部分, 百分比部分]
     */
    const splitValuePct = (idx) => {
        const raw = cells[idx] || '';
        // 尝试 " | " 分隔（innerText 换行时）
        const pipeParts = raw.split(/\s*\|\s*/).map(s => s.trim());
        if (pipeParts.length >= 2) return pipeParts;

        // 空格分隔：找最后一个百分号前的内容
        const pctMatch = raw.match(/([+-]?[\d,]*\.?\d*%)/);
        if (pctMatch) {
            const pctStr = pctMatch[1];
            const valueStr = raw.replace(pctStr, '').replace(/\s+$/, '').trim();
            return [valueStr, pctStr];
        }
        return [raw, ''];
    };

    // Cell 0: 合约 | 类型 | 方向 | 杠杆
    // 格式: "ETHUSDC | 永续|中性 20x|移动" 或 "ETHUSDC 永续 中性 20x 移动"
    const c0raw = cells[0] || '';
    // 提取合约名（第一个 token 或 | 之前的部分）
    b['合约'] = c0raw.split(/[\s|]/)[0].replace(/永续.*$/, '').replace(/Perpetual.*$/i, '').trim();
    // 方向和杠杆
    b['方向'] = c0raw.match(/(中性|做多|做空)/)?.[1] || '';
    const lm = c0raw.match(/(\d+x)/)?.[1];
    b['杠杆'] = (lm || '') + (c0raw.includes('移动') ? ' 移动' : '');

    // Cell 1: 日期 | 时间
    // 格式: "2026-04-27 | 18:47:23" 或 "2026-04-27 18:47:23"
    const c1raw = cells[1] || '';
    const dtm = c1raw.match(/(\d{4}-\d{2}-\d{2})[\s|]*(\d{2}:\d{2}:\d{2})/);
    if (dtm) { b['日期'] = dtm[1]; b['时间'] = dtm[2]; }
    else { b['日期'] = c1raw.split(/[\s|]/)[0]; b['时间'] = ''; }

    // Cell 2: 已投保证金 | 保证金类型
    // 格式: "1,000.00 USDC | (逐仓)" 或 "1,000.00 USDC (逐仓)"
    const c2raw = cells[2] || '';
    const mv = c2raw.match(/([\d,]+\.?\d*)/);
    b['已投保证金'] = mv ? mv[1] : c2raw;
    const mtMatch = c2raw.match(/[(\uff08]([^)\uff09]+)[)\uff09]/);
    b['保证金类型'] = mtMatch ? mtMatch[1] : c2raw.replace(/[\d,.\s]+USDC\s*/, '').replace(/[()]/g, '').trim();

    // Cell 3: 总收益 + 收益率
    const c3 = splitValuePct(3);
    b['总收益'] = safeUSDC(c3[0]);
    b['收益率'] = safePct(c3[1]);

    // Cell 4: 资金费用 + 费率
    const c4 = splitValuePct(4);
    b['资金费用'] = safeUSDC(c4[0]);
    b['费率'] = safePct(c4[1]);

    // Cell 5: 已配对利润 + 配对收益率
    const c5 = splitValuePct(5);
    b['已配对利润'] = safeUSDC(c5[0]);
    b['配对收益率'] = safePct(c5[1]);

    // Cell 6: 未配对盈亏 + 未配对率
    const c6 = splitValuePct(6);
    b['未配对盈亏'] = safeUSDC(c6[0]);
    b['未配对率'] = safePct(c6[1]);

    // Cell 7: 配对次数
    b['配对次数'] = (cells[7] || '').match(/\d+/)?.[0] || '';

    // Cell 8: 价格区间下限 | 上限
    // 格式: "2266.25 - | 2345.80" 或 "2266.25 - 2345.80"
    const c8raw = cells[8] || '';
    // 去掉 "-" 分隔符，取两个数字部分
    const priceParts = c8raw.replace(/[-/]\s*/, ' ').split(/[\s|]+/).filter(s => /[\d]/.test(s));
    b['价格区间下限'] = (priceParts[0] || '').replace(/[-\s]/g, '').trim();
    b['价格区间上限'] = (priceParts[1] || '').trim();

    // Cell 9: 网格数量
    b['网格数量'] = (cells[9] || '').match(/\d+/)?.[0] || '';

    // Cell 10: 每笔数量
    const c10 = cells[10] || '';
    const am = c10.match(/([\d,]+\.?\d*)/);
    b['每笔数量'] = am ? am[1] + (c10.includes('ETH') ? ' ETH' : ' USDC') : c10;

    // Cell 11: 止盈价 | 止损价
    // 格式: "-- / | --" 或 "-- / --"
    const c11raw = cells[11] || '';
    const tpParts = c11raw.split(/[\s|/]+/).map(s => s.trim()).filter(Boolean);
    b['止盈价'] = (tpParts[0] || '').replace(/[-\s]/g, '') || '--';
    b['止损价'] = (tpParts[1] || '') || '--';

    // Cell 12: 运行时间
    b['运行时间'] = (cells[12] || '').trim();

    // Cell 13: 强平价格
    b['强平价格'] = (cells[13] || '').trim();

    // Cell 14: 网格状态
    const statusRaw = (cells[14] || '').trim();
    b['网格状态'] = statusRaw.includes('运行中') ? '运行中'
                  : statusRaw.includes('已停止') ? '已停止' : statusRaw;

    // Cell 15: 风险率
    const riskRaw = (cells[15] || '').trim();
    const rm = riskRaw.match(/(\d+\.?\d*)\s*(低|中|高)风险/);
    b['风险率'] = rm ? `${rm[1]} (${rm[2]})` : riskRaw;

    return !b['合约'] || !b['已投保证金'] ? null : b;
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
