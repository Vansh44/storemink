-- One platform-wide Mink voice provider. There is deliberately no store-level
-- override: every dictation request resolves this singleton at request time.
CREATE TABLE public.mink_voice_settings (
  id         boolean PRIMARY KEY DEFAULT true,
  provider   text NOT NULL DEFAULT 'chirp_3',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  CONSTRAINT mink_voice_settings_id_check CHECK (id),
  CONSTRAINT mink_voice_settings_provider_check
    CHECK (provider = ANY (ARRAY['chirp_3'::text, 'saaras_v4'::text]))
);

ALTER TABLE public.mink_voice_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mink_voice_settings FROM app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE public.mink_voice_settings TO app_service;

INSERT INTO public.mink_voice_settings (id, provider)
VALUES (true, 'chirp_3')
ON CONFLICT (id) DO NOTHING;

-- Merchant-visible microphone behaviour changed from cumulative browser
-- interim results to one final server transcript. Correct the existing guide
-- in place; do not add another release-note section.
UPDATE public.help_articles
SET body = replace(
      body,
      $old$<h2>Live microphone dictation</h2>
<p>Choose the microphone once and begin speaking. After browser permission, Mink shows a listening indicator and puts recognised words into the message box in real time. You do not need to record a voice note or wait for an upload to finish. The Send button is available as soon as the message contains recognised text; sending ends the active dictation and sends that visible text once.</p>
<p>Choose <strong>Finish</strong> to keep editing the dictated text, or <strong>Cancel</strong> to remove the current dictation and restore the message you had before listening. Recognition stops after 60 seconds, if the tab is hidden, or when a chat turn begins. Check names, SKUs, locations and numbers because interim words can be revised or misheard.</p>
<p>StoreMink does not create, upload or save a microphone audio file in this flow. Speech recognition is supplied by the browser and its service may process audio under its own privacy and retention terms. Use HTTPS and a current Chrome or Edge browser. If microphone access is blocked, allow it for this site and retry; if browser speech recognition is unavailable, type the message. This is dictation, not a live voice conversation.</p>$old$,
      $new$<h2>Microphone dictation</h2>
<p>Choose the microphone and begin speaking. Choose <strong>Finish</strong>, or wait for the 30-second limit, to convert that recording into one editable transcript in the message box. Choose <strong>Cancel</strong> before conversion finishes to discard the recording. Dictation does not send a chat request automatically.</p>
<p>Check and correct names, SKUs, locations and numbers before you press Send. The transcript is added once after conversion, so it does not repeat interim phrases while you speak. This is dictation, not a live voice conversation.</p>
<p>StoreMink sends the temporary microphone recording to its configured speech service and does not save it as an attachment, Media file or memory. The speech service may process it under its own privacy and retention terms. HTTPS, microphone permission and browser audio support are required; otherwise type the message.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$The separate microphone starts <strong>Dictate message</strong> immediately after browser permission. Recognised words appear in the message box while you speak and may be corrected as the browser refines them. It is not a voice attachment. Finish keeps the editable text; Cancel removes that dictation and restores the text that was present before listening. HTTPS and a supported current Chrome or Edge browser are required; otherwise type your request.$old$,
      $new$The separate microphone starts <strong>Dictate message</strong> after browser permission. Speak, then choose Finish to convert the recording into one editable transcript. Cancel discards pending dictation. It is not a voice attachment, and nothing is sent to Mink until you press Send. HTTPS and browser audio support are required; otherwise type your request.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$Audio files, video, spreadsheets and long documents are not supported: the microphone is live dictation, not an attachment.$old$,
      $new$Audio files, video, spreadsheets and long documents are not attachments: use the microphone for dictation.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published';
