const fetch = require('node-fetch');
const CryptoJS = require('crypto-js');

function aesDecrypt(encryptedData, key) {
    try {
        const parsed = JSON.parse(encryptedData);
        const salt = CryptoJS.enc.Hex.parse(parsed.s);
        const iv = CryptoJS.enc.Hex.parse(parsed.iv);
        const ct = CryptoJS.enc.Base64.parse(parsed.ct);
        const keyPass = CryptoJS.enc.Utf8.parse(key);
        const derivedKey = CryptoJS.PBKDF2(keyPass, salt, {
            keySize: 256 / 32,
            iterations: 999,
            hasher: CryptoJS.algo.SHA512,
        });
        const decrypted = CryptoJS.AES.decrypt(
            { ciphertext: ct },
            derivedKey,
            { iv, padding: CryptoJS.pad.Pkcs7 }
        );
        return decrypted.toString(CryptoJS.enc.Utf8);
    } catch (e) {
        return null;
    }
}

async function test() {
    // Simulate what getVideo returns based on the log
    const getVideoText = `{"hls":true,"videoImage":"https://homemdosaco.top/cdn/down/disk9/7fa66ad614f325e12b7a7fe8abd8290c/thumb.jpg","videoSource":"https://llanfairpwllgwyngy.com/cdn/hls/7fa66ad614f325e12b7a7fe8abd8290c/master.m3u8?md5=EgXA8NXIHKD_9dZtx4nf0g&expires=1773025807","securedLink":null,"downloadLinks":null,"attachmentLinks":null,"ck":"somekey"}`;

    // Let's actually call the real endpoint fresh
    const pageRes = await fetch('https://warezcdn.site/filme/tt0468569', {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Referer': 'https://warezcdn.site/',
        },
        redirect: 'follow',
    });
    const html = await pageRes.text();
    const csrfToken = html.match(/var\s+CSRF_TOKEN\s*=\s*["']([^"']+)["']/i)?.[1];
    const contentid = html.match(/var\s+INITIAL_CONTENT_ID\s*=\s*(\d+)/i)?.[1];
    const pageToken = html.match(/var\s+PAGE_TOKEN\s*=\s*["']([^"']+)["']/i)?.[1];

    console.log('CSRF:', csrfToken?.substring(0, 20), 'ContentID:', contentid, 'PageToken:', pageToken?.substring(0, 20));

    // Get options
    const optRes = await fetch('https://warezcdn.site/player/options', {
        method: 'POST',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': 'https://warezcdn.site/filme/tt0468569',
            'X-Requested-With': 'XMLHttpRequest',
        },
        body: `contentid=${contentid}&type=filme&_token=${csrfToken}&page_token=${pageToken}`,
    });
    const optJson = await optRes.json();
    const videoId = optJson?.data?.options?.[0]?.ID;
    console.log('VideoID:', videoId, 'OptJSON:', JSON.stringify(optJson?.data?.options?.[0]));

    // Get source
    const srcRes = await fetch('https://warezcdn.site/player/source', {
        method: 'POST',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': 'https://warezcdn.site/filme/tt0468569',
            'X-Requested-With': 'XMLHttpRequest',
        },
        body: `video_id=${videoId}&_token=${csrfToken}&page_token=${pageToken}`,
    });
    const srcJson = await srcRes.json();
    const redirectUrl = srcJson?.data?.video_url;
    console.log('RedirectURL:', redirectUrl?.substring(0, 80));

    // Follow redirect
    const rRes = await fetch(redirectUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://warezcdn.site/' },
        redirect: 'follow',
    });
    const providerUrl = rRes.url;
    const providerHtml = await rRes.text();
    const dataHash = providerUrl.match(/\/video\/([a-f0-9]{32,})/i)?.[1];
    const providerOrigin = new URL(providerUrl).origin;
    console.log('ProviderURL:', providerUrl.substring(0, 80), 'Hash:', dataHash);

    // getVideo
    const gvRes = await fetch(`${providerOrigin}/player/index.php?data=${dataHash}&do=getVideo`, {
        method: 'POST',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': providerUrl,
            'Origin': providerOrigin,
            'X-Requested-With': 'XMLHttpRequest',
        },
        body: `r=${encodeURIComponent('https://warezcdn.site/filme/tt0468569')}&d=${encodeURIComponent(new URL(providerOrigin).hostname)}`,
    });
    const gvText = await gvRes.text();
    console.log('\n=== getVideo FULL RESPONSE ===');
    console.log(gvText);

    const gvJson = JSON.parse(gvText);
    console.log('\n=== KEYS:', Object.keys(gvJson));
    console.log('hls type:', typeof gvJson.hls, 'value:', gvJson.hls);
    console.log('videoSource type:', typeof gvJson.videoSource, 'value:', gvJson.videoSource?.substring(0, 100));
    console.log('ck:', gvJson.ck?.substring(0, 50));

    // Try to decrypt videoSource if it's encrypted
    if (gvJson.videoSource && gvJson.ck) {
        try {
            const dec = aesDecrypt(gvJson.videoSource, gvJson.ck);
            console.log('\n=== DECRYPTED videoSource:', dec?.substring(0, 200));
        } catch (e) {
            console.log('\nDecrypt failed:', e.message);
        }
    }
}

test().catch(console.error);
