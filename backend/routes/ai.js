const router = require('express').Router();
const https = require('https');

// POST /api/ai/chat
router.post('/chat', async function(req, res) {
  try {
    var messages = req.body.messages || [];
    if (!messages.length) {
      return res.status(400).json({ success: false, message: 'No messages provided' });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ success: false, message: 'AI service not configured' });
    }

    var systemPrompt = 'You are Lexa, a smart and witty AI assistant for LocalFix — a local service marketplace in Gorakhpur, India. You have a warm, natural personality. Rules:\n1. Reply in natural fluent English only. Max 2 sentences. Be conversational, occasionally funny.\n2. NEVER repeat the same phrasing twice in a conversation. Vary your words every time.\n3. Services we offer: Plumber, Electrician, Carpenter, Painter, AC Technician, Mason, Welder, Cleaner.\n4. For service requests: sound excited, say what you are doing e.g. "On it! Finding top-rated plumbers near you right now." Never use the same phrase twice.\n5. For unavailable services (doctor, cook, driver, tutor, etc.): decline warmly and mention our 8 services creatively.\n6. For greetings or small talk: respond warmly, ask what they need.\n7. For booking questions: they need to sign in first, then tap the calendar icon on any worker card.\n8. For pricing: LocalFix is completely free for customers — zero commission, no hidden fees.\n9. For complaints or frustration: empathize genuinely and offer to help find the right worker.\n10. For unclear messages: ask a clever clarifying question.\n11. For "ok/yes/show/find": if a service was mentioned earlier, confirm searching for that specific service.\n12. Never sound like a robot. Sound like a knowledgeable, helpful friend.';

    var body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system: systemPrompt,
      messages: messages.slice(-8) // last 8 messages for context
    });

    var options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-length': Buffer.byteLength(body)
      }
    };

    var apiReq = https.request(options, function(apiRes) {
      var data = '';
      apiRes.on('data', function(chunk) { data += chunk; });
      apiRes.on('end', function() {
        try {
          var parsed = JSON.parse(data);
          if (parsed.content && parsed.content[0] && parsed.content[0].text) {
            return res.json({ success: true, reply: parsed.content[0].text.trim() });
          } else {
            console.error('[AI] Unexpected response:', data);
            return res.json({ success: false, message: 'No reply from AI' });
          }
        } catch(e) {
          console.error('[AI] Parse error:', e.message);
          return res.status(500).json({ success: false, message: 'AI response parse error' });
        }
      });
    });

    apiReq.on('error', function(err) {
      console.error('[AI] Request error:', err.message);
      res.status(500).json({ success: false, message: 'AI request failed' });
    });

    apiReq.write(body);
    apiReq.end();

  } catch(err) {
    console.error('[AI] Error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
