-- Forward-only Help Centre correction: the composer microphone is live
-- browser dictation, not a recorded voice attachment or a Vertex audio upload.
UPDATE public.help_articles
SET body = replace(body,
      '<h2>Review an image, PDF or voice note with Mink AI</h2>',
      '<h2>Review an image or PDF, or dictate text</h2>'),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';

UPDATE public.help_articles
SET body = replace(body,
      'Use <strong>+ (Add image or document)</strong> or drop one file onto the message box for reviewed image, PDF or WAV-file extraction. The separate microphone is now <strong>Dictate message</strong>: consent on first use, speak, then Stop to convert speech into editable message text. It is not a voice attachment. Hiding the page or discarding before Stop cancels dictation. HTTPS, microphone permission and AudioWorklet support are required; otherwise type your request.',
      'Use <strong>+ (Add image or document)</strong> or drop one supported image, PDF, text or Markdown file onto the message box for review. The separate microphone starts <strong>Dictate message</strong> immediately after browser permission. Recognised words appear in the message box while you speak and may be corrected as the browser refines them. It is not a voice attachment. Finish keeps the editable text; Cancel removes that dictation and restores the text that was present before listening. HTTPS and a supported current Chrome or Edge browser are required; otherwise type your request.'),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';

UPDATE public.help_articles
SET body = replace(body,
      '<p>Each file must be no larger than <strong>2 MiB</strong>. Images support single-frame PNG, JPEG or WebP up to 12 megapixels; StoreMink strips image metadata and resizes them to at most 1600 pixels per side. PDFs support up to <strong>10 pages</strong>; encrypted, damaged, active-content or form PDFs are rejected. Voice accepts canonical mono 16 kHz, 16-bit PCM WAV up to <strong>60 seconds</strong>. MP3, WebM, video, spreadsheets and long documents are not supported. The separate Add text document control still accepts short UTF-8 text or Markdown files.</p>',
      '<p>Each extracted file must be no larger than <strong>2 MiB</strong>. Images support single-frame PNG, JPEG or WebP up to 12 megapixels; StoreMink strips image metadata and resizes them to at most 1600 pixels per side. PDFs support up to <strong>10 pages</strong>; encrypted, damaged, active-content or form PDFs are rejected. Audio files, MP3, WAV, WebM, video, spreadsheets and long documents are not composer attachments. Short UTF-8 text or Markdown files up to 8 KiB are read locally.</p>'),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';

UPDATE public.help_articles
SET body = replace(body,
      '<p>Review and correct the extracted reference. Image descriptions, PDF summaries and speech transcripts can omit or misread details; they are not verified stock levels or action approvals. Confirm the reviewed text, then choose <strong>Add reviewed reference to message</strong>. Nothing is sent to the chatbot until you press Send. Extraction is limited to 3,000 characters and the combined chat message remains limited to 4,000 characters. Shorten the excerpt if it does not fit. Chat and follow-up turns receive only the reviewed text, not the original image, PDF or audio.</p>',
      '<p>Review and correct extracted image or PDF text because it can omit or misread details; it is not a verified stock level or action approval. Confirm the reviewed text, then choose <strong>Add reviewed reference to message</strong>. Dictated words are already editable in the message box. Nothing is sent to the chatbot until you press Send. Extraction is limited to 3,000 characters and the combined chat message remains limited to 4,000 characters. Chat and follow-up turns receive only the reviewed text, not the original image or PDF.</p>'),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';

UPDATE public.help_articles
SET body = replace(replace(replace(body,
      'documents, images and voice extraction',
      'documents, images and live dictation'),
      'supported images, PDFs and WAV audio are limited to 2 MiB',
      'supported images and PDFs are limited to 2 MiB'),
      '<p>Use the separate <strong>microphone button</strong> to dictate your message. On first use in this conversation/composer, choose <strong>Start dictation</strong> to consent to Vertex speech-to-text processing and grant microphone permission. Speak, then choose <strong>Stop dictation</strong>. Stop, or the 60-second limit, converts your speech and inserts plain editable text in the message box, not a voice attachment. Correct any misheard words before Send. Nothing is sent as a chat request automatically. HTTPS and browser audio support are required. Provider processing/retention and shared input limits apply; beta transcription deducts no AI credits. Discard or hide the page before stopping to cancel without transcription.</p>',
      '<p>Use the separate <strong>microphone button</strong> to start live dictation immediately after granting browser permission. Recognised words appear in the editable message box while you speak, so Send becomes available as soon as there is text. Interim wording may change as recognition improves. Finish, the 60-second limit or Send keeps the current text; Cancel restores the message that existed before listening. Dictation never sends automatically and never grants action approval. StoreMink does not upload or retain raw microphone audio; the browser speech service may process it under that browser provider''s rules. HTTPS and supported-browser speech recognition are required.</p>'),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';

UPDATE public.help_articles
SET body = replace(body,
      '<p>An attachment review panel opens only when needed. Files requiring AI extraction have a separate processing consent step, followed by editable text review. Short text documents need only local text review. Choose <strong>Add reviewed reference to message</strong>, then send your message yourself. Dictation instead inserts text directly for editing, with no audio attachment or reference wrapper. Escape, the close button, or Discard input cancels local attachment/dictation work. Cancelling cannot retract bytes already sent to Vertex. The usual 4,000-character combined message limit applies.</p>',
      '<p>An attachment review panel opens only when needed. Images and PDFs require separate extraction consent and editable text review; short text documents need only local review. Choose <strong>Add reviewed reference to message</strong>, then send your message yourself. Dictation inserts text directly with no audio attachment or reference wrapper. Escape, close or Discard cancels attachment work; Escape or Cancel during dictation restores the earlier message. Cancelling an attachment cannot retract bytes already sent to Vertex. The usual 4,000-character combined message limit applies.</p>'),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';

UPDATE public.help_articles
SET body = $guide$
<h2>Live microphone dictation</h2>
<p>Choose the microphone once and begin speaking. After browser permission, Mink shows a listening indicator and puts recognised words into the message box in real time. You do not need to record a voice note or wait for Vertex conversion. The Send button is available as soon as the message contains recognised text; sending ends the active dictation and sends that visible text once.</p>
<p>Choose <strong>Finish</strong> to keep editing the dictated text, or <strong>Cancel</strong> to remove the current dictation and restore the message you had before listening. Recognition stops after 60 seconds, if the tab is hidden, or when a chat turn begins. Check names, SKUs, locations and numbers because interim words can be revised or misheard.</p>
<p>StoreMink does not create, upload or save a microphone audio file in this flow. Speech recognition is supplied by the browser and its service may process audio under its own privacy and retention terms. Use HTTPS and a current Chrome or Edge browser. If microphone access is blocked, allow it for this site and retry; if browser speech recognition is unavailable, type the message. This is dictation, not a live voice conversation.</p>
<p>If ordinary chat works after deployment but fails during local development with an expired-login message, run <code>gcloud auth application-default login</code> for the development account and restart the StoreMink development server. Production should use its configured service account instead of an interactive user login.</p>
$guide$ || body,
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published'
  AND body NOT LIKE '%<h2>Live microphone dictation</h2>%';

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND category_id IS NOT NULL
      AND body LIKE '%<h2>Live microphone dictation</h2>%'
      AND body LIKE '%recognised words into the message box in real time%'
      AND body LIKE '%does not create, upload or save a microphone audio file%'
      AND body LIKE '%gcloud auth application-default login%'
  ) THEN
    RAISE EXCEPTION 'Mink live-dictation guidance was not installed';
  END IF;
END $verify$;
