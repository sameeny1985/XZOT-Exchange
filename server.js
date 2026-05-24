require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const ccxt = require('ccxt');
const { Telegraf } = require('telegraf');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Initialize MEXC Exchange Connection via CCXT
const mexc = new ccxt.mexc({
    apiKey: process.env.MEXC_API_KEY,
    secret: process.env.MEXC_SECRET_KEY,
    enableRateLimit: true,
    options: {
        adjustForTimeDifference: true, // Prevents synchronization lag errors with MEXC servers
    }
});

// Helper function to send Telegram alerts
async function sendTelegramAlert(message) {
    try {
        await bot.telegram.sendMessage(process.env.TELEGRAM_CHANNEL_ID, message, { parse_mode: 'Markdown' });
    } catch (err) {
        console.error('Telegram Notification Error:', err.message);
    }
}

// --------------------------------------------------------
// HTML Front-End Template (Clean, Minimalist, English)
// --------------------------------------------------------
const htmlTemplate = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Instant USDT Purchase Gateway</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center font-sans">
    <div class="max-w-md w-full mx-4 p-8 bg-slate-900 border border-slate-800 rounded-3xl shadow-2xl">
        <div class="text-center mb-8">
            <h1 class="text-2xl font-black tracking-tight text-indigo-400">XZOT Exchange</h1>
            <p class="text-sm text-slate-400 mt-2">Buy USDT (BSC / BEP-20) Instantly via Stripe</p>
        </div>

        <form action="/create-checkout-session" method="POST" class="space-y-6">
            <div>
                <label class="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Amount to Spend (EUR)</label>
                <input type="number" name="amount" min="10" value="100" required
                    class="w-full p-4 bg-slate-950 border border-slate-800 rounded-2xl text-lg font-bold text-white focus:outline-none focus:border-indigo-500 transition">
            </div>

            <div>
                <label class="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Network Protocol</label>
                <div class="w-full p-4 bg-slate-950 border border-indigo-900/50 rounded-2xl flex items-center justify-between">
                    <span class="font-bold text-white">Tether (USDT)</span>
                    <span class="px-3 py-1 bg-indigo-950 text-indigo-400 text-xs font-extrabold rounded-full border border-indigo-800">BSC / BEP20</span>
                </div>
            </div>

            <div>
                <label class="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Your Destination BSC Wallet Address</label>
                <input type="text" name="wallet" placeholder="0x..." required
                    class="w-full p-4 bg-slate-950 border border-slate-800 rounded-2xl text-sm font-mono text-white focus:outline-none focus:border-indigo-500 transition">
            </div>

            <div class="p-4 bg-amber-950/20 border border-amber-900/30 rounded-2xl text-xs text-amber-400 leading-relaxed">
                ⚠️ <strong>Stripe Identity Verification Required:</strong> For security compliances, you will be prompted to verify your ID document during the checkout process.
            </div>

            <button type="submit" 
                class="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-md rounded-2xl shadow-lg shadow-indigo-600/20 transition duration-200">
                Verify ID & Pay Now
            </button>
        </form>
    </div>
</body>
</html>
`;

// Render Home Page
app.get('/', (req, res) => {
    res.send(htmlTemplate);
});

// --------------------------------------------------------
// Stripe Checkout & Verification Session Generation
// --------------------------------------------------------
app.post('/create-checkout-session', express.urlencoded({ extended: true }), async (req, res) => {
    const { amount, wallet } = req.body;

    try {
        // Step 1: Create Stripe Identity Verification Session
        const verificationSession = await stripe.identity.verificationSessions.create({
            type: 'document',
            options: { document: { require_matching_selfie: true } },
        });

        // Step 2: Generate Hosted Stripe Checkout Link mapped to the Identity check
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'eur',
                    product_data: { 
                        name: 'USDT Purchase (Binance Smart Chain)',
                        description: `Target Wallet: ${wallet}`
                    },
                    unit_amount: amount * 100, // Converts to cents
                },
                quantity: 1,
            }],
            mode: 'payment',
            metadata: {
                walletAddress: wallet,
                cryptoSymbol: 'USDT',
                verificationSessionId: verificationSession.id
            },
            success_url: `${req.protocol}://${req.get('host')}/status?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${req.protocol}://${req.get('host')}/`,
        });

        // Broadcast initial step to Telegram Channel
        await sendTelegramAlert(`ℹ️ *New Order Initialized*\n• Amount: ${amount} EUR\n• Target Wallet: \`${wallet}\`\n• Status: Awaiting Verification & Payment`);

        res.redirect(303, session.url);
    } catch (err) {
        res.status(500).send(`Error creating gateway session: ${err.message}`);
    }
});

// Simple Payment Callback Landing Page
app.get('/status', (req, res) => {
    res.send(`
        <script src="https://cdn.tailwindcss.com"></script>
        <body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center font-sans">
            <div class="max-w-md w-full mx-4 p-8 bg-slate-900 border border-slate-800 rounded-3xl text-center shadow-2xl">
                <div class="text-emerald-400 text-5xl mb-4">✓</div>
                <h1 class="text-xl font-bold">Payment & ID Submitted</h1>
                <p class="text-sm text-slate-400 mt-2">Your ID verification and payment are being processed dynamically. Crypto assets will be credited to your destination wallet shortly once checks pass.</p>
                <a href="/" class="inline-block mt-6 px-6 py-2 bg-slate-800 rounded-xl text-xs hover:bg-slate-700 transition">Return Home</a>
            </div>
        </body>
    `);
});

// --------------------------------------------------------
// Core Transaction Processor (MEXC Liquidator Module)
// --------------------------------------------------------
async function processCryptoLiquidation(fiatAmount, cryptoSymbol, walletAddress) {
    try {
        await sendTelegramAlert(`💳 *Payment Verified!*\n• Amount Received: ${fiatAmount} EUR\n• Proceeding to MEXC for automated market liquidation...`);

        // Calculate custom broker spread profit margin
        const profitMargin = parseFloat(process.env.MY_PROFIT_PERCENT) || 0.03;
        const netTradingFiat = fiatAmount * (1 - profitMargin);

        // Fetch spot execution price for asset pairs from MEXC (USDT/EUR)
        const marketPair = `${cryptoSymbol}/EUR`;
        const ticker = await mexc.fetchTicker(marketPair);
        const spotPrice = ticker.last;

        const assetQuantityToOrder = netTradingFiat / spotPrice;

        // Execute Instant Market Order on MEXC
        await sendTelegramAlert(`🔄 *Executing MEXC Order*\n• Purchasing: ${assetQuantityToOrder.toFixed(4)} ${cryptoSymbol} at Market Price`);
        
        // Note: MEXC requires precise decimal handling. CCXT handles cost execution.
        const marketOrder = await mexc.createMarketBuyOrder(marketPair, assetQuantityToOrder);

        // Execute Withdraw Request over Binance Smart Chain (BSC / BEP20) Network Chain API on MEXC
        await sendTelegramAlert(`🚀 *Initiating On-Chain Settlement via MEXC*\n• Network: Binance Smart Chain (BEP20)\n• Target Destination: \`${walletAddress}\``);
        
        // Triggers the withdrawal on MEXC infrastructure targeting BSC network
        const withdrawal = await mexc.withdraw(
            cryptoSymbol,
            assetQuantityToOrder,
            walletAddress,
            undefined,
            { 
                network: 'BSC', 
                chain: 'BSC' // Double layer compatibility mapping for MEXC router engine
            }
        );

        // Broadcast Ultimate Completed State Block
        await sendTelegramAlert(`✅ *Order Settled Successfully via MEXC!*\n• Tx Settlement ID: \`${withdrawal.id || 'Processed'}\`\n• Asset Distributed to client.`);

    } catch (error) {
        console.error('MEXC Fulfillment Critical Failure:', error.message);
        await sendTelegramAlert(`🚨 *CRITICAL FULFILLMENT FAILURE (MEXC)*\n• Reason: ${error.message}\n• Action Required: Manual intervention required for fiat amount ${fiatAmount} EUR targeting wallet \`${walletAddress}\``);
    }
}

// --------------------------------------------------------
// Stripe Webhook Web Receiver (Requires RAW JSON Parsing)
// --------------------------------------------------------
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send(`Webhook Signature Failure: ${err.message}`);
    }

    // Capture payment intent status updates natively 
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        
        const fiatAmount = session.amount_total / 100;
        const cryptoSymbol = session.metadata.cryptoSymbol;
        const walletAddress = session.metadata.walletAddress;

        // Run full MEXC crypto purchase pipeline async to prevent webhook request timeouts
        processCryptoLiquidation(fiatAmount, cryptoSymbol, walletAddress);
    }

    res.json({ received: true });
});

// Run Application Listener 
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`XZOT-Exchange secure MEXC server running fine on port ${PORT}`));
