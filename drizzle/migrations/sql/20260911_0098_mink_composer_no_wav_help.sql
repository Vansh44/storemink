-- The composer does not take an audio file, so the guide must stop offering one.
--
-- WHY. 20260910_0093 republished the Mink guide to remove content a merchant
-- cannot act on, and its own limits paragraph kept "Voice accepts canonical
-- mono 16 kHz, 16-bit PCM WAV up to 60 seconds" from the recorded-audio design
-- that 20260910_0092 superseded. The dashboard composer refuses every audio
-- file: COMPOSER_FILE_ACCEPT omits .wav, and choose() answers one with "Use the
-- microphone button for speech to text". The server's input API still validates
-- WAV as compatibility code, but nothing a merchant can reach ever sends one.
--
-- ⚠ IT ALSO CONTRADICTED THE PARAGRAPH ABOVE IT, which already said audio files
-- are not supported and that the microphone is dictation rather than an
-- attachment. A guide that answers the same question two ways in two paragraphs
-- is the exact defect 0093 exists to remove, so this finishes that job.
--
-- The same sentence called the file control "separate" from itself. There is
-- one + (Add image or document) control; the 8 KiB text limit is stated because
-- it is the one number that differs from the 2 MiB applied to everything else.
--
-- Forward-only: 0093 is applied, so its SQL is immutable and the inaccurate
-- paragraph is replaced in place here (AGENTS.md), not appended beside.

UPDATE public.help_articles
SET body = replace(body,
      $old$PDFs support up to <strong>10 pages</strong>; encrypted, damaged, active-content or form PDFs are rejected. Voice accepts canonical mono 16 kHz, 16-bit PCM WAV up to <strong>60 seconds</strong>. MP3, WebM, video, spreadsheets and long documents are not supported. The separate + (Add image or document) control still accepts short UTF-8 text or Markdown files.</p>$old$,
      $new$PDFs support up to <strong>10 pages</strong>; encrypted, damaged, active-content or form PDFs are rejected. The same <strong>+ (Add image or document)</strong> control takes short UTF-8 text or Markdown files up to 8 KiB, which are read on your own device rather than sent for extraction. Audio files, video, spreadsheets and long documents are not supported: the microphone is live dictation, not an attachment.</p>$new$),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';

DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published'
      AND category_id IS NOT NULL
      AND body NOT LIKE '%PCM WAV%'
      AND body NOT LIKE '%The separate + (Add image or document) control%'
      AND body LIKE '%the microphone is live dictation, not an attachment%') THEN
    RAISE EXCEPTION 'Mink guide still offers an audio-file attachment the composer refuses';
  END IF;
END $verify$;
