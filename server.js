require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');

const app = express();
const port = process.env.PORT || 8080;

// ایجاد ربات تلگرام برای نوتیفیکیشن‌ها
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// تابع کمکی برای ارسال پیام به تلگرام
async function sendTelegramAlert(message) {
    try {
        await bot.telegram.sendMessage(process.env.TELEGRAM_CHANNEL_ID, message, { parse_mode: 'Markdown' });
    } catch (err) {
        console.error('Telegram notification error:', err.message);
    }
}

// مسیر ثبت شروع سفارش و ارسال نوティفیکیشن اولیه
app.post('/api/initiate-order', async (req, res) => {
    const { amount, wallet, gateway } = req.body;

    const alertMessage = `🔔 *یک سفارش جدید ثبت شد*\n\n` +
                         `💵 *مبلغ:* ${amount} EUR/USD\n` +
                         `💳 *درگاه انتخابی:* ${gateway === 'transak' ? 'Transak 🔵' : 'MoonPay 🟣'}\n` +
                         `👛 *آدرس ولت مقصد:* \`${wallet}\`\n` +
                         `⏳ *وضعیت:* در انتظار پرداخت و احراز هویت توسط کاربر`;

    await sendTelegramAlert(alertMessage);
    res.json({ success: true });
});

// وب‌هوک برای دریافت نوتیفیکیشن‌های ترنزک یا مون‌پی (پس از تایید پرداخت آن‌ها)
app.post('/api/webhook/payment-success', async (req, res) => {
    // این بخش سیگنال موفقیت آمیز بودن واریز تتر توسط درگاه را دریافت می‌کند
    const event = req.body; 
    
    // شما می‌توانید بر اساس ساختار دیتای ارسالی ترنزک/مون‌پی جزییات را فیلتر کنید
    const successMessage = `✅ *تراکنش با موفقیت انجام شد!*\n\n` +
                           `💰 تتر با موفقیت توسط درگاه خریداری و به ولت مشتری ارسال شد.\n` +
                           `📈 سود شما به ولت \`${process.env.MY_WALLET_ADDRESS}\` واریز شد.`;

    await sendTelegramAlert(successMessage);
    res.sendStatus(200);
});

// اجرای سرور
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
