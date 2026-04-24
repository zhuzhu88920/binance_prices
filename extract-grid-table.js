/**
 * Binance 网格机器人表格提取 → CSV (修复版 v3)
 * 
 * 核心改进：
 * 1. 不再猜测行边界 — 用精确的起始标记匹配
 * 2. 每个机器人固定25个原始字段行，按已知顺序直接映射
 * 3. 遇到非数据内容立即停止
 * 
 * 前提: Edge 以 --remote-debugging-port=9222 启动
 * 用法: node.exe extract-grid-table.js
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, 'output');
const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT_CSV = path.join(OUTPUT_DIR, `grid_bots_${TS}.csv`);

// CSV 表头（24个字段）
const HEADERS = [
    '合约', '方向', '杠杆', '日期', '时间',
    '已投保证金', '保证金类型', '总收益', '收益率',
    '资金费用', '费率', '已配对利润', '配对收益率',
    '未配对盈亏', '未配对率', '配对次数',
    '价格区间下限', '价格区间上限', '网格数量', '每笔数量',
    '止盈价', '止损价', '运行时间', '强平价格',
    '网格状态', '风险率'
];

async function main() {
    console.log('╔══════════════════════════════════════╗');
    console.log('║ 🤖 Binance 网格机器人表格抓取 v3     ║');
    console.log('╚══════════════════════════════════════╝\n');

    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const page = browser.contexts()[0].pages()[0];
    console.log(`🔗 ${await page.title()}`);
    console.log(`📍 ${page.url()}\n`);

    await page.waitForTimeout(1500);

    // ===== 步骤1: 提取页面全部文本行 =====
    const lines = await page.evaluate(() => {
        return document.body.innerText
            .split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 0);
    });

    // ===== 步骤2: 定位表头和数据区域 =====
    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i] === '合约') {
            const ahead = lines.slice(i + 1, i + 4).join('');
            if (ahead.includes('时间') && ahead.includes('已投保证金')) {
                headerIdx = i;
                break;
            }
        }
    }

    if (headerIdx < 0) {
        console.log('❌ 未找到表格。请确认当前页面是 Binance 合约/网格交易页面');
        await browser.close();
        return;
    }

    // 表头有17行: 合约→操作，数据行紧随其后（不跳过）
    const HEADER_ROWS = 17;
    const dataRegionStart = headerIdx + HEADER_ROWS;  // 第一个机器人紧接表头后

    console.log(`📋 表头: 第${headerIdx}~${headerIdx+HEADER_ROWS-1}行`);
    console.log(`📊 数据区: 第${dataRegionStart}行起\n`);

    // ===== 步骤3: 从数据区提取所有机器人的原始行组 =====
    const botGroups = [];  // 每个元素是一个 string[]，包含一个机器人的所有行

    for (let i = dataRegionStart; i < lines.length; i++) {
        const line = lines[i];

        // 跳过非数据行
        if (!line || line.match(/^(隐藏其他|新建网格|账户|切换)/)) continue;
        if (/Cookie|活动中心|公告|风险揭示|合约交流房/.test(line)) break;

        // 检查是否是机器人开始行: "ETHUSDC 永续" 或 "BTCUSDT 永续"
        if (/(ETH|BTC|SOL)\w*\s*永续/.test(line)) {
            botGroups.push([]);  // 开始一个新的机器人
        }

        // 将行添加到当前机器人
        if (botGroups.length > 0) {
            botGroups[botGroups.length - 1].push(line);

            // 最后一个机器人会把后面的非数据行也吸进来，parse时只取前25行即可
        }

        // 总体安全限制
        if (botGroups.length >= 10) break;
    }

    console.log(`🔍 发现 ${botGroups.length} 个候选机器人\n`);

    // ===== 步骤4: 解析每个机器人 =====
    const bots = [];
    
    for (let g = 0; g < botGroups.length; g++) {
        const raw = botGroups[g];
        
        // 过滤太短的（少于10行的不可能是完整机器人数据）
        if (raw.length < 10) {
            console.log(`  ⏭️ 组#${g+1} 仅 ${raw.length} 行，跳过`);
            continue;
        }

        const bot = parseOneBot(raw, g + 1);
        if (bot) bots.push(bot);
    }

    // ===== 输出结果 =====
    if (bots.length === 0) {
        console.log('❌ 没有成功解析任何机器人数据\n');
        console.log('--- 原始数据区域 ---');
        lines.slice(dataRegionStart, dataRegionStart + 50).forEach((l, i) => {
            console.log(`[${dataRegionStart+i}] ${l}`);
        });
        await browser.close();
        return;
    }

    console.log(`✅ 成功解析 ${bots.length} 个网格机器人!\n`);

    // 写CSV
    writeCSV(bots, OUT_CSV);
    printPreview(bots);

    await browser.close();
    console.log('🔌 断开完成');
}

/**
 * 解析单个机器人的原始行数组
 * 
 * Binance DOM 中每行对应一个表格单元格，顺序如下:
 * [0] "ETHUSDC 永续"
 * [1] "中性 20x移动" / "做多 10x"
 * [2] "2026-04-23"
 * [3] "11:55:43"
 * [4] "1,500.00 USDC"
 * [5] "(逐仓)"
 * [6] "+62.15 USDC"      ← 总收益金额
 * [7] "+4.14%"           ← 收益率
 * [8] "+0.15 USDC"       ← 资金费用
 * [9] "+0.01%"           ← 资金费率
 * [10] "+65.47 USDC"     ← 已配对利润
 * [11] "+4.36%"          ← 配对收益率
 * [12] "-3.48 USDC"      ← 未配对盈亏
 * [13] "-0.23%"          ← 未配对率
 * [14] "135"             ← 配对次数
 * [15] "2200.00 -"       ← 价格区间下行
 * [16] "2400.00"         ← 价格区间上行
 * [17] "65"              ← 网格数量
 * [18] "363.63636 USDC"  ← 每笔数量
 * [19] "-- /"            ← 止盈
 * [20] "--"              ← 止损
 * [21] "21时 11分"       ← 运行时间
 * [22] "--" / "10,518.52"← 强平价格 (或数字)
 * [23] "运行中"          ← 状态
 * [24] "1.8 低风险"      ← 风险率
 */
function parseOneBot(rawLines, botNum) {
    if (!rawLines || rawLines.length < 15) return null;

    const b = {};
    let i = 0;

    // [0] 合约名
    const contractLine = rawLines[i++] || '';
    const cm = contractLine.match(/((?:ETH|BTC|SOL)\w*)\s*永续/);
    b['合约'] = cm ? cm[1] + 'USDC' : contractLine;

    // [1] 方向+杠杆
    const dl = rawLines[i++] || '';
    const dm = dl.match(/(中性|做多|做空)/);
    const lm = dl.match(/(\d+x)/);
    b['方向'] = dm?.[1] || '';
    b['杠杆'] = (lm?.[1] || '') + (dl.includes('移动') ? ' 移动' : '');

    // [2][3] 日期+时间
    const dateL = rawLines[i++] || '';
    const timeL = rawLines[i++] || '';
    if (/\d{4}-\d{2}-\d{2}/.test(dateL)) {
        b['日期'] = dateL.trim();
        b['时间'] = timeL.trim();
    } else {
        // 可能合并在一行
        const dtm = dateL.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
        if (dtm) { b['日期'] = dtm[1]; b['时间'] = dtm[2]; i--; }  // 回退一个i因为没用到timeL
    }

    // [4][5] 已投保证金 + 类型
    const marginVal = rawLines[i++] || '';
    const marginType = rawLines[i++] || '';
    const mv = marginVal.match(/([\d,]+\.?\d*)/);
    b['已投保证金'] = mv ? mv[1] + ' USDC' : marginVal;
    b['保证金类型'] = marginType.replace(/[()]/g, '').trim();

    // [6][7] 总收益 + %
    b['总收益']   = safeUSDC(rawLines[i++]);
    b['收益率']   = safePct(rawLines[i++]);

    // [8][9] 资金费用 + %
    b['资金费用'] = safeUSDC(rawLines[i++]);
    b['费率']     = safePct(rawLines[i++]);

    // [10][11] 已配对利润 + %
    b['已配对利润'] = safeUSDC(rawLines[i++]);
    b['配对收益率'] = safePct(rawLines[i++]);

    // [12][13] 未配对盈亏 + %
    b['未配对盈亏'] = safeUSDC(rawLines[i++]);
    b['未配对率']   = safePct(rawLines[i++]);

    // [14] 配对次数
    b['配对次数'] = (rawLines[i++] || '').match(/\d+/)?.[0] || '';

    // [15][16] 价格区间 (两行: "2200.00 -" 和 "2400.00")
    const pLo = rawLines[i++] || '';
    const pHi = rawLines[i++] || '';
    b['价格区间下限'] = pLo.replace(/[-\s]/g, '').trim() || '';
    b['价格区间上限'] = pHi.trim();

    // [17] 网格数量
    b['网格数量'] = (rawLines[i++] || '').match(/\d+/)?.[0] || '';

    // [18] 每笔数量
    const amt = rawLines[i++] || '';
    const am = amt.match(/([\d,]+\.?\d*)/);
    b['每笔数量'] = am ? am[1] + (amt.includes('ETH') ? ' ETH' : ' USDC') : amt;

    // [19][20] 止盈/止损
    b['止盈价'] = (rawLines[i++] || '').replace(/[/\s]/g, '').trim();
    b['止损价'] = (rawLines[i++] || '').trim();

    // [21] 运行时间
    b['运行时间'] = (rawLines[i++] || '').trim();

    // [22] 强平价格
    b['强平价格'] = (rawLines[i++] || '').trim();

    // [23] 状态
    const statusLine = rawLines[i++] || '';
    b['网格状态'] = statusLine.includes('运行中') ? '运行中'
                    : statusLine.includes('已停止') ? '已停止'
                    : statusLine.trim();

    // [24] 风险率
    const riskLine = rawLines[i++] || '';
    const rm = riskLine.match(/(\d+\.?\d*)\s*(低|中|高)风险/);
    b['风险率'] = rm ? `${rm[1]} (${rm[2]})` : riskLine.trim();

    // 验证：如果关键字段都为空则丢弃
    if (!b['合约'] || !b['已投保证金']) {
        console.log(`  ⚠️ 机器人#${botNum} 关键字段缺失，丢弃`);
        return null;
    }

    return b;
}

/** 提取 "±X.XX USDC" 格式的值 */
function safeUSDC(str) {
    const s = (str || '');
    const m = s.match(/([+-]?[\d,]+\.?\d*)/);
    return m ? m[1] + ' USDC' : s.replace(/[()]/g, '').trim();
}

/** 提取 "X.XX%" 格式的值 */
function safePct(str) {
    const s = (str || '');
    const m = s.match(/([+-]?[\d,]*\.?\d*)%/);
    return m ? m[0] : (s.match(/\d/) ? s.trim() : '');
}

function writeCSV(bots, filePath) {
    const esc = v => {
        const s = String(v ?? '');
        return /[,"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = [
        '\uFEFF' + HEADERS.map(esc).join(','),
        ...bots.map(bot => HEADERS.map(h => esc(bot[h] ?? '')).join(','))
    ].join('\n');
    fs.writeFileSync(filePath, content, 'utf-8');
}

function printPreview(bots) {
    if (!bots.length) return;

    console.log('┌──────────┬──────┬────────┬────────────┬───────────┬──────────┬──────┐');
    console.log('│ 合约     │ 方向 │ 杠杆   │ 已投保证金 │ 总收益     │ 运行时间  │ 状态  │');
    console.log('├──────────┼──────┼────────┼────────────┼───────────┼──────────┼──────┤');
    
    bots.forEach(b => {
        console.log(
            '│' + (b['合约']||'').padEnd(9) +
            '│' + (b['方向']||'').padEnd(5) +
            '│' + (b['杠杆']||'').padEnd(7) +
            '│' + (b['已投保证金']||'').padEnd(11) +
            '│' + (b['总收益']||'').padEnd(10) +
            '│' + (b['运行时间']||'').padEnd(9) +
            '│' + (b['网格状态']||'').padEnd(5) + '│'
        );
    });
    console.log('└──────────┴──────┴────────┴────────────┴───────────┴──────────┴──────┘');
    console.log(`\n💾 ${OUT_CSV}\n`);

    bots.forEach((b, idx) => {
        console.log(`━━━ #${idx+1}: ${b['合约']} ${b['方向']} ${b['杠杆']} ━━━`);
        ['日期','时间','已投保证金','总收益','收益率','资金费用','已配对利润','未配对盈亏','配对次数',
         '价格区间下限','价格区间上限','网格数量','每笔数量','运行时间','强平价格','网格状态','风险率'].forEach(k => {
            if (b[k]) console.log(`  ${k}: ${b[k]}`);
        });
        console.log('');
    });
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
