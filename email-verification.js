import { createHash, randomBytes } from 'node:crypto';

export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export const EMAIL_VERIFICATION_RESEND_COOLDOWN_MS = 60 * 1000;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null;
}

export function hashEmailVerificationToken(token) {
    return createHash('sha256').update(String(token || '')).digest('hex');
}

export function getEmailVerificationStatus(user) {
    if (!normalizeEmail(user?.email)) return 'missing';
    return user?.emailVerifiedAt ? 'verified' : 'unverified';
}

export function maskEmail(value) {
    const email = normalizeEmail(value);
    if (!email) return null;
    const [local, domain] = email.split('@');
    const visible = local.slice(0, Math.min(2, local.length));
    return `${visible}${'*'.repeat(Math.max(1, Math.min(6, local.length - visible.length)))}@${domain}`;
}

export function serializeEmailVerification(user) {
    const status = getEmailVerificationStatus(user);
    return {
        emailVerificationStatus: status,
        emailVerified: status === 'verified',
        emailVerifiedAt: user?.emailVerifiedAt || null,
        emailMasked: maskEmail(user?.email),
    };
}

export function createEmailVerificationRequiredError(user) {
    const status = getEmailVerificationStatus(user);
    if (status === 'verified') return null;
    const error = new Error(status === 'missing'
        ? 'Add and verify an email address before continuing.'
        : 'Verify your email address before continuing.');
    error.status = 403;
    error.code = 'EMAIL_VERIFICATION_REQUIRED';
    error.details = {
        emailVerificationStatus: status,
        emailRequired: status === 'missing',
        emailMasked: maskEmail(user?.email),
    };
    return error;
}

function escapeHtml(value) {
    return String(value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

export function createEmailVerificationService({
    User,
    fetchImpl,
    frontendUrl,
    apiKey,
    from,
    replyTo = '',
    now = () => Date.now(),
    randomToken = () => randomBytes(32).toString('hex'),
}) {
    if (!User) throw new Error('Email verification requires a User model');

    async function deliverVerificationEmail({ email, username, token }) {
        if (!apiKey || !from) {
            const error = new Error('Email delivery is not configured');
            error.code = 'EMAIL_DELIVERY_NOT_CONFIGURED';
            error.status = 503;
            throw error;
        }
        const verificationUrl = `${String(frontendUrl || '').replace(/\/$/, '')}/verify-email?token=${encodeURIComponent(token)}`;
        const safeUsername = escapeHtml(username || 'player');
        const response = await fetchImpl('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Idempotency-Key': `email-verification/${hashEmailVerificationToken(token).slice(0, 32)}`,
            },
            body: JSON.stringify({
                from,
                to: [email],
                subject: 'Verify your Arenifi email',
                ...(replyTo ? { reply_to: replyTo } : {}),
                text: `Hi ${username || 'player'}, verify your Arenifi email: ${verificationUrl}\n\nThis link expires in 24 hours. If you did not request it, you can ignore this email.`,
                html: `<!doctype html><html><body style="margin:0;background:#09090d;color:#f4f1ff;font-family:Arial,sans-serif"><div style="max-width:520px;margin:0 auto;padding:42px 24px"><div style="color:#a78bfa;font-size:12px;font-weight:800;letter-spacing:.16em;text-transform:uppercase">ARENIFI</div><h1 style="font-size:26px;margin:16px 0 10px">Verify your email</h1><p style="color:#b6b2c2;line-height:1.6">Hi ${safeUsername}, confirm this email once to secure username changes and withdrawals.</p><a href="${verificationUrl}" style="display:inline-block;margin:18px 0;padding:13px 20px;border-radius:10px;background:#8b5cf6;color:white;text-decoration:none;font-weight:800">Verify email</a><p style="color:#777384;font-size:12px;line-height:1.6">This link expires in 24 hours. If you did not request it, ignore this email.</p></div></body></html>`,
            }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(payload?.message || `Email provider returned HTTP ${response.status}`);
            error.code = 'EMAIL_DELIVERY_FAILED';
            error.status = 502;
            throw error;
        }
        return payload;
    }

    async function start(user, requestedEmail = null) {
        if (!user) throw Object.assign(new Error('Account not found'), { status: 404 });
        const currentStatus = getEmailVerificationStatus(user);
        const requested = requestedEmail == null || requestedEmail === ''
            ? normalizeEmail(user.email)
            : normalizeEmail(requestedEmail);
        if (!requested) throw Object.assign(new Error('Enter a valid email address'), { status: 400, code: 'INVALID_EMAIL' });
        if (currentStatus === 'verified' && requested === normalizeEmail(user.email)) {
            return { alreadyVerified: true, ...serializeEmailVerification(user) };
        }
        if (currentStatus === 'verified' && requested !== normalizeEmail(user.email)) {
            throw Object.assign(new Error('This account already has a verified email address'), { status: 409, code: 'EMAIL_ALREADY_VERIFIED' });
        }

        const duplicate = await User.exists({ email: requested, _id: { $ne: user._id } });
        if (duplicate) throw Object.assign(new Error('That email address is already connected to another account'), { status: 409, code: 'EMAIL_ALREADY_USED' });

        const timestamp = now();
        const emailChanged = requested !== normalizeEmail(user.email);
        const lastSent = new Date(user.emailVerificationLastSentAt || 0).getTime();
        if (!emailChanged && lastSent > 0 && timestamp - lastSent < EMAIL_VERIFICATION_RESEND_COOLDOWN_MS) {
            const retryAfterSeconds = Math.max(1, Math.ceil((EMAIL_VERIFICATION_RESEND_COOLDOWN_MS - (timestamp - lastSent)) / 1000));
            throw Object.assign(new Error(`Wait ${retryAfterSeconds} seconds before sending another email`), {
                status: 429,
                code: 'EMAIL_VERIFICATION_COOLDOWN',
                retryAfterSeconds,
            });
        }

        const token = randomToken();
        user.email = requested;
        user.emailVerifiedAt = null;
        user.emailVerificationTokenHash = hashEmailVerificationToken(token);
        user.emailVerificationExpiresAt = new Date(timestamp + EMAIL_VERIFICATION_TTL_MS);
        user.emailVerificationLastSentAt = new Date(timestamp);
        await user.save();

        try {
            await deliverVerificationEmail({ email: requested, username: user.username, token });
        } catch (error) {
            await User.updateOne(
                { _id: user._id, emailVerificationTokenHash: user.emailVerificationTokenHash },
                { $set: { emailVerificationLastSentAt: null } },
            ).catch(() => {});
            throw error;
        }
        return { sent: true, emailMasked: maskEmail(requested), emailVerificationStatus: 'unverified' };
    }

    async function confirm(rawToken) {
        const token = String(rawToken || '').trim();
        if (!/^[a-f0-9]{64}$/i.test(token)) {
            throw Object.assign(new Error('This verification link is invalid or has expired'), { status: 400, code: 'INVALID_VERIFICATION_TOKEN' });
        }
        const tokenHash = hashEmailVerificationToken(token);
        const verifiedAt = new Date(now());
        const user = await User.findOneAndUpdate(
            {
                emailVerificationTokenHash: tokenHash,
                emailVerificationExpiresAt: { $gt: verifiedAt },
                email: { $type: 'string', $ne: '' },
            },
            {
                $set: { emailVerifiedAt: verifiedAt },
                $unset: {
                    emailVerificationTokenHash: 1,
                    emailVerificationExpiresAt: 1,
                    emailVerificationLastSentAt: 1,
                },
            },
            { new: true },
        );
        if (!user) {
            throw Object.assign(new Error('This verification link is invalid or has expired'), { status: 400, code: 'INVALID_VERIFICATION_TOKEN' });
        }
        return user;
    }

    return { start, confirm };
}
