require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const ccxt = require('ccxt');

const app = express();
const port = process.env.PORT || 8080;

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

const mexc = new ccxt.mexc({
    apiKey: process.env.MEXC_API_KEY,
    secret: process.env.MEXC_SECRET_KEY,
});

app.use(express.json());
app.use(express.static('public'));

const pendingOrders = {};

// ۱. دریافت اطلاعات از سایت و ارسال به تلگرام با دکمه شیشه‌ای
app.post('/api/submit-paysafe', async (req, res) => {
    const { amount, wallet, pin } = req.body;

    if (!amount || !wallet || !pin) {
        return res.status(400).json({ success: false, message: 'اطلاعات ناقص است.' });
    }

    const orderId = 'ORD-' + Date.now();
    pendingOrders[orderId] = { amount, wallet, pin, status: 'PENDING' };

    const alertMessage = `💳 *سفارش پی‌سیف‌کارت جدید*\n\n` +
                         `🆔 *آیدی:* \`${orderId}\`\n` +
                         `💵 *مبلغ:* ${amount} EUR\n` +
                         `🔑 *کد ۱۶ رقمی:* \`${pin}\`\n` +
                         `👛 *ولت مشتری:* \`${wallet}\`\n\n` +
                         `👇 پس از اطمینان از نقد شدن کارت، روی دکمه زیر کلیک کنید:`;

    try {
        // ساخت دکمه شیشه‌ای تایید و رد سفارش
        await bot.telegram.sendMessage(
            process.env.TELEGRAM_CHANNEL_ID, 
            alertMessage, 
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [
                        Markup.button.callback('✅ تایید و واریز تتر', `approve_${orderId}`),
                        Markup.button.callback('❌ رد سفارش', `reject_${orderId}`)
                    ]
                ])
            }
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: 'خطا در ارتباط با تلگرام' });
    }
});

// ۲. پردازش کلیک روی دکمه‌های شیشه‌ای
bot.on('callback_query', async (ctx) => {
    const callbackData = ctx.callbackQuery.data; // مثلا: approve_ORD-12345
    const [action, orderId] = callbackData.split('_');

    const order = pendingOrders[orderId];

    if (!order) {
        return ctx.answerCbQuery('❌ سفارش یافت نشد یا منقضی شده است.', { show_alert: true });
    }

    if (order.status !== 'PENDING') {
        return ctx.answerCbQuery('⚠️ این سفارش قبلاً بررسی شده است.', { show_alert: true });
    }

    if (action === 'reject') {
        order.status = 'REJECTED';
        await ctx.editMessageText(`❌ *سفارش ${orderId} توسط مدیر رد شد.*`, { parse_mode: 'Markdown' });
        return ctx.answerCbQuery('سفارش رد شد.');
    }

    if (action === 'approve') {
        // اطلاع‌رسانی اولیه روی دکمه
        ctx.answerCbQuery('⏳ در حال خرید و انتقال تتر...');
        await ctx.editMessageText(`⏳ *سفارش ${orderId} در حال پردازش خودکار صرافی...*`, { parse_mode: 'Markdown' });

        try {
            // محاسبه کارمزد (کارمزد پی‌سیف + کارمزد شما، مثلاً جمعاً ۱۵ درصد)
            const profitPercent = parseFloat(process.env.MY_PROFIT_PERCENT || '0.15');
            const netAmount = order.amount * (1 - profitPercent);
            const usdtToWithdraw = netAmount.toFixed(2);

            // انتقال مستقیم تتر از مکسی به ولت مشتری
            await mexc.withdraw('USDT', usdtToWithdraw, order.wallet, undefined, { network: 'BSC' });

            order.status = 'COMPLETED';
            await ctx.editMessageText(`✅ *سفارش ${orderId} با موفقیت تکمیل شد!*\n💰 مقدار *${usdtToWithdraw} USDT* به ولت مشتری واریز شد.`, { parse_mode: 'Markdown' });

        } catch (error) {
            order.status = 'FAILED';
            await ctx.editMessageText(`❌ *خطا در صرافی:* \n${error.message}`, { parse_mode: 'Markdown' });
        }
    }
});

bot.launch();

app.listen(port, () => console.log(`Server running on port ${port}`));
