-- Forward-only Help update. Does not enable multimodal processing or change grants.
UPDATE public.help_articles
SET body = replace(body,
  'This input release does not support PDFs, images, screenshots, audio, voice transcription, spreadsheets, external URL fetching or automatic document processing. Paste a short text excerpt instead.',
  'The Add text document control accepts only short text and Markdown files. Use the separately enabled Add image, PDF or voice control for reviewed image/PDF/voice extraction. Spreadsheets, external URL fetching and automatic document processing remain unsupported.'),
  updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';

UPDATE public.help_articles
SET body = body || $guide$
<h2>Review an image, PDF or voice note with Mink AI</h2>
<p>When your operator enables multimodal input, open <strong>Add image, PDF or voice</strong> beside the chat composer. Choose one file or choose <strong>Record voice</strong>. Recording needs HTTPS, microphone permission and AudioWorklet support; it stays on your device until you approve processing. Stop to listen, or discard it. Hiding the page discards an active recording. If recording is unavailable, attach a supported WAV file or type your request.</p>
<p>Each file must be no larger than <strong>2 MiB</strong>. Images support single-frame PNG, JPEG or WebP up to 12 megapixels; StoreMink strips image metadata and resizes them to at most 1600 pixels per side. PDFs support up to <strong>10 pages</strong>; encrypted, damaged, active-content or form PDFs are rejected. Voice accepts canonical mono 16 kHz, 16-bit PCM WAV up to <strong>60 seconds</strong>. MP3, WebM, video, spreadsheets and long documents are not supported. The separate Add text document control still accepts short UTF-8 text or Markdown files.</p>
<p>Remove secrets and unnecessary customer details first. Check the processing consent box and choose <strong>Process for review</strong>. This sends the file to Vertex AI before you send a chat message. StoreMink does not save the raw file in its database, Media library or saved memories; the provider's retention policies still apply. Cancelling cannot retract bytes already sent to the provider.</p>
<p>Review and correct the extracted reference. Image descriptions, PDF summaries and speech transcripts can omit or misread details; they are not verified stock levels or action approvals. Confirm the reviewed text, then choose <strong>Add reviewed reference to message</strong>. Nothing is sent to the chatbot until you press Send. Extraction is limited to 3,000 characters and the combined chat message remains limited to 4,000 characters. Shorten the excerpt if it does not fit. Chat and follow-up turns receive only the reviewed text, not the original image, PDF or audio.</p>
<p>Beta extraction deducts no AI credits but incurs provider usage. A separate chat request follows the existing read/draft/action charging rules. Shared processing limits are five requests per admin per minute, 30 per store per hour, 100 per store per day and a platform-wide limit. Failed, cancelled and duplicate attempts also consume limits. Processing has a 45-second deadline and rejects overly complex inputs or incomplete responses. It does not automatically retry. After a failure, wait and explicitly approve another attempt; provider work from a timed-out request might still have incurred usage.</p>
<p>If the control is unavailable, ask your operator to check MINK_MULTIMODAL_ENABLED, the existing Mink invitation and dashboard permissions, and whether the configured Vertex model supports the input in the configured location. Permission, capacity, safety and provider failures do not silently fall back to another model. Keep using typed prompts or short text documents while this is checked.</p>
<p>Closing, discarding or changing conversations cancels pending local work; the microphone is stopped and local previews are released. Deleting a chat follows the existing conversation policy and does not retract earlier provider processing. This feature does not generate or place images, save memories, publish storefronts, change stock or authorize any other action. Approval rules remain unchanged.</p>
$guide$, updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published'
  AND body NOT LIKE '%<h2>Review an image, PDF or voice note with Mink AI</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published'
      AND category_id IS NOT NULL
      AND body LIKE '%<h2>Review an image, PDF or voice note with Mink AI</h2>%'
      AND body LIKE '%MINK_MULTIMODAL_ENABLED%'
      AND body LIKE '%does not save the raw file%'
      AND body LIKE '%not the original image, PDF or audio%'
  ) THEN
    RAISE EXCEPTION 'Mink Phase 8E input guidance was not installed';
  END IF;
END $$;
