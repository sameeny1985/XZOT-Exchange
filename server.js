require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const ccxt = require('ccxt');

const app = express();
const port = process.env.PORT || 8080;

// تنظیمات ربات تلگرام
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// تنظیمات صرافی مکسی (برای خرید خودکار پس از تایید شما)
const mexc = new ccxt.mexc({
    apiKey: process.env.MEXC_API_KEY,
    secret: process.env.MEXC_SECRET_KEY,
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ذخیره موقت سفارش‌ها در حافظه سرور برای تایید دستی
const pendingOrders = {};

// ۱. دریافت اطلاعات فرم پی‌سیف‌کارت از سایت
app.post('/api/submit-paysafe', async (req, res) => {
    const { amount, wallet, pin } = req.body;

    if (!amount || !wallet || !pin) {
        return res.status(400).json({ success: false, message: 'تمام فیلدها الزامی هستند.' });
    }

    const orderId = 'ORD-' + Date.now();
    
    // ذخیره سفارش در لیست انتظار
    pendingOrders[orderId] = { amount, wallet, pin, status: 'PENDING' };

    // ارسال پیام به کانال/گروه تلگرام شما به همراه دکمه تایید
    const alertMessage = `💳 *سفارش پی‌سیف‌کارت جدید*\n\n` +
                         `🆔 *آیدی سفارش:* \`${orderId}\`\n` +
                         `💵 *مبلغ اعلامی:* ${amount} EUR\n` +
                         `🔑 *کد ۱۶ رقمی:* \`${pin}\`\n` +
                         `👛 *ولت مقصد (BSC):* \`${wallet}\`\n\n` +
                         `⚠️ *اقدام لازم:* ابتدا کد را در اکانت Paysafecard خود وارد کنید. در صورت شارژ موفق، دستور زیر را برای ربات بفرستید:\n\n` +
                         `/approve ${orderId}`;

    try {
        await bot.telegram.sendMessage(process.env.TELEGRAM_CHANNEL_ID, alertMessage, { parse_mode: 'Markdown' });
        res.json({ success: true, message: 'سفارش شما ثبت شد و در حال بررسی است.' });
    } catch (err) {
        console.error('Telegram Error:', err);
        res.status(500).json({ success: false, message: 'خطا در ارتباط با سرور تلگرام' });
    }
});

// ۲. پردازش دستور تایید از طرف شما در تلگرام
bot.command('approve', async (ctx) => {
    const text = ctx.message.text; // مثل: /approve ORD-12345
    const parts = text.split(' ');
    const orderId = parts[1];

    if (!orderId || !pendingOrders[orderId]) {
        return ctx.reply('❌ آیدی سفارش معتبر نیست یا منقضی شده است.');
    }

    const order = pendingOrders[orderId];

    if (order.status !== 'PENDING') {
        return ctx.reply('⚠️ این سفارش قبلاً پردازش شده است.');
    }

    ctx.reply(`⏳ در حال پردازش سفارش \`${orderId}\`... اتصال به صرافی مکسی و خرید تتر.`, { parse_mode: 'Markdown' });

    try {
        // الف) گرفتن قیمت لحظه‌ای تتر به یورو از مکسی
        const ticker = await mexc.fetchTicker('USDT/EUR');
        const spotPrice = ticker.last;

        // ب) کسر کارمزد و سود شما (مثلاً کسر ۵ درصد کارمزد برای ریسک پی‌سیف‌کارت)
        const profitPercent = parseFloat(process.env.MY_PROFIT_PERCENT || '0.05');
        const netEuro = order.amount * (1 - profitPercent);
        
        // ج) محاسبه تعداد تتر قابل خرید
        const usdtAmount = (netEuro / spotPrice).toFixed(2);

        // د) ارسال دستور خرید مارکت به مکسی
        // Note: در صرافی‌ها خرید مارکت بر اساس حجم ارز پایه انجام می‌شود
        await mexc.createMarketBuyOrder('USDT/EUR', usdtAmount);

        // ه) برداشت تتر از مکسی و واریز به ولت BSC مشتری
        // مکس برای برداشت نیاز به آدرس، مقدار و شبکه (BSC/BEP20) دارد
        await mexc.withdraw('USDT', usdtAmount, order.wallet, undefined, { network: 'BSC' });

        // تغییر وضعیت سفارش
        order.status = 'COMPLETED';

        ctx.reply(`✅ *سفارش ${orderId} با موفقیت تکمیل شد!*\n\n` +
                  `💰 مقدار *${usdtAmount} USDT* پس از کسر کارمزد خریداری و به شبکه BSC واریز شد.`, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error('Execution Error:', error);
        ctx.reply(`❌ *خطا در اجرای خودکار سفارش:* \n${error.message}`, { parse_mode: 'Markdown' });
    }
});

// لانچ کردن ربات تلگرام برای گوش دادن به دستورات شما
bot.launch();

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
