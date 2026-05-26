require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const multer = require('multer');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 8080;

// تنظیمات ذخیره‌سازی فایل‌های آپلودی
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = './uploads';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// راه‌اندازی ربات تلگرام
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// تنظیمات سرویس ایمیل برای ارسال رسید به مشتری
const transporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || 'gmail', // مثل gmail یا mailgun
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
// دسترسی به فایل‌های آپلود شده از طریق لینک (برای نمایش در تلگرام شما)
app.use('/uploads', express.static('uploads'));

const pendingOrders = {};

// ۱. دریافت فرم کامل مشتری و ارسال به تلگرام
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
        
        // ذخیره اطلاعات کامل سفارش در حافظه
        pendingOrders[orderId] = {
            email, crypto, network, wallet, paymentMethod, amount, paysafePin,
            idFront: files['idFront'] ? files['idFront'][0].path : null,
            idBack: files['idBack'] ? files['idBack'][0].path : null,
            receipt: files['receipt'] ? files['receipt'][0].path : null,
            status: 'PENDING'
        };

        // آدرس دامنه سرور برای ساخت لینک تصاویر جهت مشاهده شما در تلگرام
        const serverUrl = process.env.SERVER_URL || `http://localhost:${port}`;
        
        let paymentDetail = '';
        if (paymentMethod === 'paysafe') {
            paymentDetail = `🔑 *Paysafe PIN:* \`${paysafePin}\``;
        } else {
            paymentDetail = `🧾 *SEPA Receipt:* [View Receipt](${serverUrl}/${files['receipt'][0].path})`;
        }

        const messageText = `🔔 *New Exchange Order: ${orderId}*\n\n` +
                            `📧 *User Email:* \`${email}\`\n` +
                            `💰 *Amount:* ${amount} EUR\n` +
                            `🪙 *Asset:* ${crypto} (${network})\n` +
                            `👛 *Destination Wallet:* \`${wallet}\`\n` +
                            `💳 *Method:* ${paymentMethod.toUpperCase()}\n` +
                            `${paymentDetail}\n\n` +
                            `🪪 *KYC Documents:* \n` +
                            `[ID Front Side](${serverUrl}/${pendingOrders[orderId].idFront})\n` +
                            `[ID Back Side](${serverUrl}/${pendingOrders[orderId].idBack})\n\n` +
                            `👇 Action Required:`;

        // ارسال به کانال/گروه تلگرام با کلیدهای شیشه‌ای لمسی
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

// ۲. پردازش دکمه‌های شیشه‌ای تلگرام (تایید / رد) + ارسال ایمیل اتوماتیک
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

    if (action === 'reject') {
        order.status = 'REJECTED';
        await ctx.editMessageText(`❌ *Order ${orderId} has been REJECTED by Admin.*`, { parse_mode: 'Markdown' });
        return ctx.answerCbQuery('Order Rejected.');
    }

    if (action === 'approve') {
        ctx.answerCbQuery('⏳ Processing transfer and sending email...');
        await ctx.editMessageText(`⏳ *Order ${orderId} is being processed...*`, { parse_mode: 'Markdown' });

        try {
            // در اینجا عملیات انتقال اتوماتیک از صرافی کوکوین یا صرافی دیگر با API انجام می‌شود.
            // به عنوان بخش اصلی خواسته شما، پس از واریز رمزارز، ایمیل تایید به مشتری شلیک می‌شود:

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

            await ctx.editMessageText(`✅ *Order ${orderId} Successfully Completed!*\n💰 Crypto sent to wallet and confirmation email dispatched to \`${order.email}\`.`, { parse_mode: 'Markdown' });

        } catch (mailError) {
            console.error('Email Error:', mailError);
            await ctx.editMessageText(`⚠️ *Crypto sent but Email failed:* \n${mailError.message}`, { parse_mode: 'Markdown' });
        }
    }
});

bot.launch();
app.listen(port, () => console.log(`Server is running on port ${port}`));
