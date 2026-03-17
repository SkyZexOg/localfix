const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

const otpStore = new Map();
const resendThrottle = new Map();

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function otpEmailHTML(code, type) {
  var title = type === 'signup' ? 'Verify your email' : 'Reset your password';
  return '<!DOCTYPE html><html><body style="margin:0;padding:20px;background:#f4f4f4;font-family:Arial,sans-serif">'
    + '<div style="max-width:460px;margin:0 auto;background:#080A0E;border-radius:12px;overflow:hidden">'
    + '<div style="background:#FF5C00;padding:20px 28px">'
    + '<h2 style="margin:0;color:#fff">LocalFix</h2></div>'
    + '<div style="padding:28px">'
    + '<p style="color:#F0F2F5;font-weight:600;margin:0 0 16px">' + title + '</p>'
    + '<div style="background:#141820;border-radius:10px;padding:20px;text-align:center;margin-bottom:20px">'
    + '<span style="font-size:38px;font-weight:900;letter-spacing:14px;color:#FF5C00;font-family:monospace">' + code + '</span>'
    + '</div>'
    + '<p style="color:#8B95A8;font-size:13px;margin:0">Expires in 5 minutes. Do not share.</p>'
    + '</div></div></body></html>';
}

// ✅ RESEND EMAIL FUNCTION (REPLACED)
async function sendOTPEmail(to, code, type) {
  var subject = type === 'signup'
    ? 'Your LocalFix verification code'
    : 'Reset your LocalFix password';

  await resend.emails.send({
    from: 'LocalFix <onboarding@resend.dev>',
    to: to,
    subject: subject,
    html: otpEmailHTML(code, type)
  });

  console.log('OTP sent via Resend to:', to);
}

router.post('/send-otp', async function(req, res) {
  try {
    var email = (req.body.email || '').toLowerCase().trim();
    var type = req.body.type;

    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, message: 'Valid email required.' });
    }
    if (type !== 'signup' && type !== 'reset') {
      return res.status(400).json({ success: false, message: 'Type must be signup or reset.' });
    }

    if (!process.env.RESEND_API_KEY) {
      return res.status(500).json({ success: false, message: 'Resend API key missing.' });
    }

    if (type === 'signup') {
      var r1 = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
      if (r1[0].length) {
        return res.status(409).json({ success: false, message: 'Email already registered.' });
      }
    }

    if (type === 'reset') {
      var r2 = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
      if (!r2[0].length) {
        return res.status(404).json({ success: false, message: 'No account found.' });
      }
    }

    var last = resendThrottle.get(email);
    if (last && Date.now() - last < 60000) {
      var secs = Math.ceil((60000 - (Date.now() - last)) / 1000);
      return res.status(429).json({ success: false, message: 'Wait ' + secs + ' seconds.' });
    }

    var code = generateOTP();

    otpStore.set(email, {
      code,
      expires: Date.now() + 300000,
      attempts: 0,
      type,
      verified: false
    });

    resendThrottle.set(email, Date.now());

    await sendOTPEmail(email, code, type);

    return res.json({ success: true, message: 'OTP sent successfully.' });

  } catch (err) {
    console.error('send-otp error:', err);
    return res.status(500).json({ success: false, message: 'Failed to send OTP.' });
  }
});
