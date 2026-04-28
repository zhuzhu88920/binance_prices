const axios = require('axios');
const CryptoJS = require('crypto-js');

// === 只要改这两个参数 ===
const apiKey = '你的_API_KEY';
const apiSecret = '你的_API_SECRET';
const strategyId = 'YOUR_STRATEGY_ID';

// 签名工具
function buildSignature(queryString, secret) {
    return CryptoJS.HmacSHA256(queryString, secret).toString(CryptoJS.enc.Hex);
}

async function request(baseUrl, endpoint, params) {
    const timestamp = Date.now(); // 简单处理时间
    const queryString = Object.keys(params)
        .map(key => `${key}=${encodeURIComponent(params[key])}`)
        .concat(`timestamp=${timestamp}`)
        .join('&');
    const signature = buildSignature(queryString, apiSecret);
    const url = `${baseUrl}${endpoint}?${queryString}&signature=${signature}`;

    try {
        const res = await axios.get(url, { headers: { 'X-MBX-APIKEY': apiKey, 'User-Agent': 'Mozilla/5.0' } });
        return res.data;
    } catch (e) {
        return { error: true, data: e.response ? e.response.data : e.message };
    }
}

async function run() {
    console.log("🚀 开始全能诊断...");

    // --- 尝试 1：现货网格接口 ---
    console.log("\n1️⃣ 正在检查是否为【现货网格】...");
    const spotRes = await request('https://api.binance.com', '/sapi/v1/algo/spot/ongoingOrders', {});
    if (!spotRes.error && spotRes.orders) {
        const order = spotRes.orders.find(o => o.algoId == strategyId || o.strategyId == strategyId);
        if (order) {
            console.log("✅ 找到现货网格单！数据如下：");
            console.log(JSON.stringify(order, null, 2));
            return;
        }
    }

    // --- 尝试 2：合约网格接口 ---
    console.log("\n2️⃣ 正在检查是否为【合约网格】...");
    const futRes = await request('https://fapi.binance.com', '/fapi/v1/gridTradingService/ongoingOrders', { strategyId });
    if (!futRes.error && futRes.code === "200" && futRes.data && futRes.data.length > 0) {
        console.log("✅ 找到合约网格单！数据如下：");
        console.log(JSON.stringify(futRes.data[0], null, 2));
        return;
    }

    // --- 尝试 3：如果都找不到，看账户里到底有没有钱 ---
    console.log("\n3️⃣ 正在拉取账户资产清单...");
    const balanceRes = await request('https://fapi.binance.com', '/fapi/v2/balance', {});
    if (!balanceRes.error && Array.isArray(balanceRes)) {
        const hasMoney = balanceRes.filter(b => parseFloat(b.balance) > 0);
        console.log("你的合约账户余额清单:", hasMoney.map(m => `${m.asset}: ${m.balance}`));
    } else {
        console.log("❌ 无法获取余额，可能是 IP 被拦截导致的 HTML 错误。");
    }

    console.log("\n--- 诊断结束 ---");
    console.log("如果上方没有出现数据，说明：");
    console.log("1. 你的策略 ID 确实不属于目前的接口范围。");
    console.log("2. 你的 IP 可能被币安合约网关拦截了。");
}

run();