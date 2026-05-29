require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const multer = require('multer');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const ccxt = require('ccxt');

const app = express();
const port = process.env.PORT || 8080;

// مطمئن شدن از وجود پوشه آپلودها
const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// تنظیمات ذخیره‌سازی فایل‌های آپلودی با پسوند درست
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// راه‌اندازی ربات تلگرام
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// پیکربندی صرافی MEXC با استفاده از کدهای API Key شما در محیط اینوایرومنت
const mexc = new ccxt.mexc({
    apiKey: process.env.MEXC_API_KEY,
    secret: process.env.MEXC_SECRET_KEY,
    enableRateLimit: true
});

// تنظیمات سرویس ایمیل
const transporter = nodemailer.createTransport({
    service: 'gmail', 
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS // حتما باید App Password جی‌میل باشد
    }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// دسترسی به پوشه آپلودها به صورت کاملا استاتیک و عمومی
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const pendingOrders = {};

// ۱. دریافت فرم کامل مشتری و ارسال به تلگرام (مربوط به مسیر فیات)
app.post('/api/submit-order', upload.fields([
    { name: 'idFront', maxCount: 1 },
    { name: 'idBack', maxCount: 1 },
    { name: 'receipt', maxCount: 1 }
]), async (req, res) => {
    try {
        const { email, crypto, network, wallet, paymentMethod, amount, paysafePin } = req.body;
        const files = req.files;

        if (!email || !crypto || !network || !wallet || !paymentMethod || !amount) {
            return res.status(400).json({ success: false, message: 'Missing required fields.' });
        }

        const orderId = 'ORD-' + Date.now();
        
        const idFrontPath = files['idFront'] ? files['idFront'][0].path.replace(/\\/g, '/') : null;
        const idBackPath = files['idBack'] ? files['idBack'][0].path.replace(/\\/g, '/') : null;
        const receiptPath = files['receipt'] ? files['receipt'][0].path.replace(/\\/g, '/') : null;

        pendingOrders[orderId] = {
            email, crypto, network, wallet, paymentMethod, amount, paysafePin,
            idFront: idFrontPath,
            idBack: idBackPath,
            receipt: receiptPath,
            status: 'PENDING'
        };

        let serverUrl = process.env.SERVER_URL || `http://localhost:${port}`;
        if (serverUrl.endsWith('/')) {
            serverUrl = serverUrl.slice(0, -1);
        }
        
        let paymentDetail = '';
        if (paymentMethod === 'paysafe') {
            paymentDetail = `🔑 *Paysafe PIN:* \`${paysafePin}\``;
        } else if (receiptPath) {
            paymentDetail = `🧾 *SEPA Receipt:* [View Receipt](${serverUrl}/${receiptPath})`;
        }

        const messageText = `🔔 *New Exchange Order: ${orderId}*\n\n` +
                            `📧 *User Email:* \`${email}\`\n` +
                            `💰 *Amount:* ${amount} EUR\n` +
                            `🪙 *Asset:* ${crypto} (${network})\n` +
                            `👛 *Destination Wallet:* \`${wallet}\`\n` +
                            `💳 *Method:* ${paymentMethod.toUpperCase()}\n` +
                            `${paymentDetail}\n\n` +
                            `🪪 *KYC Documents:* \n` +
                            `[ID Front Side](${serverUrl}/${idFrontPath})\n` +
                            `[ID Back Side](${serverUrl}/${idBackPath})\n\n` +
                            `👇 Action Required:`;

        pendingOrders[orderId].originalMessage = messageText;

        await bot.telegram.sendMessage(process.env.TELEGRAM_CHANNEL_ID, messageText, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [
                    Markup.button.callback('🟢 Approve & Send Crypto', `approve_${orderId}`),
                    Markup.button.callback('🔴 Reject Order', `reject_${orderId}`)
                ]
            ])
        });

        res.json({ success: true, message: 'Order submitted successfully.' });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

// ۳. اندپوینت جدید پردازش اتوماتیک سوآپ رمزارز به رمزارز صرافی MEXC
app.post('/api/crypto-swap', async (req, res) => {
    try {
        const { email, fromAsset, toAsset, amount, wallet } = req.body;

        if (!email || !fromAsset || !toAsset || !amount || !wallet) {
            return res.status(400).json({ success: false, message: 'All fields are required.' });
        }

        // بررسی اتصال معتبر به کلیدهای مکسی
        if (!process.env.MEXC_MASTER_DEPOSIT_WALLET) {
            return res.status(500).json({ success: false, message: 'Exchange backend configurations are missing.' });
        }

        const swapId = 'SWAP-' + Date.now();

        // ارسال اعلان سریع به ربات تلگرام جهت مانیتورینگ شما به عنوان مدیر پلتفرم
        const monitorText = `⚡️ *[AUTO-PILOT] New Crypto Swap Request*\n\n` +
                            `🆔 *Swap ID:* \`${swapId}\`\n` +
                            `📧 *Client Email:* \`${email}\`\n` +
                            `📥 *User Sends:* ${amount} ${fromAsset} (TRC20)\n` +
                            `📤 *User Receives:* ${toAsset}\n` +
                            `👛 *Client Target Wallet:* \`${wallet}\`\n\n` +
                            `⏳ _Waiting for automated deposit network validation on MEXC wallet..._`;

        await bot.telegram.sendMessage(process.env.TELEGRAM_CHANNEL_ID, monitorText, { parse_mode: 'Markdown' });

        // فرستادن ولت اصلی مکسی ثبت شده در متغیر محیطی سرور به کاربر برای واریز تتر
        res.json({ 
            success: true, 
            swapId,
            depositAddress: process.env.MEXC_MASTER_DEPOSIT_WALLET 
        });

        // اجرای موتور پس‌زمینه بررسی اتوماتیک و واریز (به صورت موازی و آسنکرون بدون قفل کردن فرانت اند)
        runAutoLiquidityEngine(swapId, email, fromAsset, toAsset, parseFloat(amount), wallet);

    } catch (error) {
        console.error('Swap Route Error:', error);
        res.status(500).json({ success: false, message: 'Swap processing failed.' });
    }
});

// موتور سنگین و هوشمند رهگیری تراکنش‌های واریزی بلاکچین در حساب مکسی، تبدیل بازار و برداشت مستقیم برای کاربر
async function runAutoLiquidityEngine(swapId, email, fromAsset, toAsset, expectedAmount, targetWallet) {
    let checkCount = 0;
    const maxChecks = 30; // ۳۰ بار تلاش برای رهگیری واریز (هر ۱ دقیقه یکبار = ۳۰ دقیقه انقضای فاکتور)
    
    console.log(`🤖 موتور اتوپایلوت برای سفارش ${swapId} فعال شد. در حال مانیتورینگ حساب مکسی...`);

    const interval = setInterval(async () => {
        checkCount++;
        try {
            // خواندن تاریخچه آخرین واریزها به حساب مکسی شما از طریق API
            const deposits = await mexc.fetchDeposits(fromAsset, undefined, 5);
            
            // یافتن تراکنش تتر ورودی بر اساس مقدار و وضعیت موفق آن بر روی شبکه
            const matchingDeposit = deposits.find(d => 
                d.amount >= expectedAmount && 
                (d.status === 'ok' || d.status === 'successful')
            );

            if (matchingDeposit) {
                clearInterval(interval);
                console.log(`✅ تراکنش واریزی یافت شد! مقدار: ${matchingDeposit.amount} ${fromAsset}. شروع فرآیند خرید بازار...`);
                
                await bot.telegram.sendMessage(process.env.TELEGRAM_CHANNEL_ID, `💵 *[Auto-Pilot]* Deposit of ${matchingDeposit.amount} ${fromAsset} detected on MEXC! Executing market conversion...`, { parse_mode: 'Markdown' });

                // ۱. فرستادن دستور خرید مارکت به صرافی مکسی (فروش تتر و خرید ارز مقصد)
                const marketSymbol = `${toAsset}/${fromAsset}`; // ساخت جفت ارز برای مارکت مثلا BTC/USDT
                const order = await mexc.createMarketOrder(marketSymbol, 'buy', matchingDeposit.amount);
                
                // ۲. کسر ۲ درصد کارمزد شخصی صرافی شما و آماده‌سازی کل موجودی برای انتقال خودکار به ولت مشتری
                const calculatedDelivery = order.amount * 0.98;

                console.log(`🔄 عملیات تبدیل در بازار انجام شد. مقدار ناخالص خریده شده: ${order.amount}. ارسال خودکار به کیف پول مشتری...`);

                // ۳. استفاده از متد برداشت خودکار API مکسی برای ارسال رمزارز نهایی به آدرس ولت مقصد مشتری
                await mexc.withdraw(toAsset, calculatedDelivery, targetWallet);

                // ارسال گزارش موفقیت نهایی به تلگرام ادمین
                const successText = `✅ *[AUTO-PILOT SUCCESS]*\n\n` +
                                    `🆔 *Swap ID:* \`${swapId}\`\n` +
                                    `📧 *User:* \`${email}\`\n` +
                                    `💵 *Deposit Detected:* ${matchingDeposit.amount} ${fromAsset}\n` +
                                    `🪙 *Swapped to:* ${calculatedDelivery} ${toAsset} (2% Fee deducted)\n` +
                                    `✈️ *Status:* Dispatched via API to network wallet successfully!`;

                await bot.telegram.sendMessage(process.env.TELEGRAM_CHANNEL_ID, successText, { parse_mode: 'Markdown' });

                // ارسال ایمیل رسید اتوماتیک برای مشتری
                try {
                    await transporter.sendMail({
                        from: process.env.EMAIL_USER,
                        to: email,
                        subject: 'Your Automated Crypto Swap is Complete! ⚡️',
                        html: `<div style="direction: ltr; font-family: Arial; padding: 20px; border: 1px solid #ffdd00; background: #1a1a24; color: #fff; border-radius: 8px;">
                                <h2 style="color: #ffdd00; text-align: center;">Swap Successful</h2>
                                <p>Your crypto swap order <strong>${swapId}</strong> has been executed via autopilot.</p>
                                <p><strong>Sent Amount:</strong> ${matchingDeposit.amount} ${fromAsset}</p>
                                <p><strong>Delivered Amount:</strong> ${calculatedDelivery} ${toAsset}</p>
                                <p><strong>Target Destination:</strong> ${targetWallet}</p>
                               </div>`
                    });
                } catch (err) { console.error('Swap Mail Delivery failed:', err); }
            }

            if (checkCount >= maxChecks) {
                clearInterval(interval);
                console.log(`🛑 زمان انقضای فاکتور سفارش ${swapId} به پایان رسید.`);
                await bot.telegram.sendMessage(process.env.TELEGRAM_CHANNEL_ID, `🛑 *[Auto-Pilot]* Swap order \`${swapId}\` expired. No matching deposit detected within 30 minutes.`, { parse_mode: 'Markdown' });
            }

        } catch (err) {
            console.error('Error tracking liquidity inside engine:', err.message);
        }
    }, 60000); // تکرار بررسی اکانت صرافی به صورت مداوم در هر ۶۰ ثانیه
}

// ۲. پردازش دکمه‌های شیشه‌ای تلگرام (تایید / رد مربوط به فرم فیات و پی‌سیف قدیمی)
bot.on('callback_query', async (ctx) => {
    const callbackData = ctx.callbackQuery.data;
    const [action, orderId] = callbackData.split('_');
    const order = pendingOrders[orderId];

    if (!order) {
        return ctx.answerCbQuery('❌ Order not found or expired.', { show_alert: true });
    }

    if (order.status !== 'PENDING') {
        return ctx.answerCbQuery('⚠️ This order has already been processed.', { show_alert: true });
    }

    const baseText = order.originalMessage || `🔔 *Exchange Order: ${orderId}*`;

    if (action === 'reject') {
        order.status = 'REJECTED';
        await ctx.editMessageText(`${baseText}\n\n❌ *Status: REJECTED by Admin.*`, { parse_mode: 'Markdown' });
        return ctx.answerCbQuery('Order Rejected.');
    }

    if (action === 'approve') {
        ctx.answerCbQuery('⏳ Verification approved. Dispatching email...');
        await ctx.editMessageText(`${baseText}\n\n⏳ *Status: Processing transfer & sending email...*`, { parse_mode: 'Markdown' });

        try {
            const mailOptions = {
                from: process.env.EMAIL_USER,
                to: order.email,
                subject: 'Your Crypto Exchange Order has been Completed! ✅',
                html: `
                    <div style="direction: ltr; font-family: Arial, sans-serif; padding: 20px; border: 1px solid #ffdd00; border-radius: 8px; background-color: #1a1a24; color: #ffffff;">
                        <h2 style="color: #ffdd00; text-align: center;">Transaction Successful</h2>
                        <p>Dear Customer,</p>
                        <p>We are pleased to inform you that your exchange order <strong>${orderId}</strong> has been successfully verified and processed.</p>
                        <hr style="border-color: #ffdd00;">
                        <p><strong>Paid Amount:</strong> ${order.amount} EUR</p>
                        <p><strong>Received Crypto:</strong> ${order.crypto}</p>
                        <p><strong>Network:</strong> ${order.network}</p>
                        <p><strong>Destination Wallet:</strong> <span style="color: #ffdd00;">${order.wallet}</span></p>
                        <hr style="border-color: #ffdd00;">
                        <p style="text-align: center; font-size: 12px; color: #9ca3af;">Thank you for choosing XZOT Exchange.</p>
                    </div>
                `
            };

            await transporter.sendMail(mailOptions);
            order.status = 'COMPLETED';
            await ctx.editMessageText(`${baseText}\n\n✅ *Status: COMPLETED.*\n💰 Crypto assets delivered and email notification sent to user.`, { parse_mode: 'Markdown' });

        } catch (mailError) {
            console.error('Email Delivery Error:', mailError);
            await ctx.editMessageText(`${baseText}\n\n⚠️ *Status: Verification approved, but Email failed:* \n\`${mailError.message}\``, { parse_mode: 'Markdown' });
        }
    }
});

// سیستم هوشمند راه‌اندازی بات تلگرام برای نابود کردن خودکار خطا و کانفلیکت ۴۰۹ در دپلوهای کویب
async function startBotWithRetry() {
    try {
        await bot.launch();
        console.log('🤖 Telegram bot launched successfully!');
    } catch (error) {
        if (error.response && error.response.error_code === 409) {
            console.log('⚠️ Telegram Conflict (409) detected. Retrying connection in 5 seconds...');
            setTimeout(startBotWithRetry, 5000);
        } else {
            console.error('❌ Failed to launch telegram bot:', error);
        }
    }
}

startBotWithRetry();

app.listen(port, () => console.log(`Server is running on port ${port}`));
