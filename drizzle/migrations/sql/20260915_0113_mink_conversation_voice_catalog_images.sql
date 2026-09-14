-- Keep new conversations available when an older thread contains retained
-- publication or action evidence, make dictation end on a natural pause, and
-- explain that named-product promotions may use catalogue photographs.
-- These are edits to existing merchant guidance, not a new release section.

UPDATE public.help_articles
SET body = replace(
      body,
      $old$Choose the microphone and begin speaking. Choose <strong>Finish</strong>, or wait for the 30-second limit, to convert that recording into one editable transcript in the message box. Choose <strong>Cancel</strong> before conversion finishes to discard the recording. Dictation does not send a chat request automatically.$old$,
      $new$Choose the microphone and begin speaking. After you speak, pause briefly and StoreMink automatically converts the recording into one editable transcript in the message box. Choose <strong>Cancel</strong> before conversion finishes to discard the recording. Dictation does not send a chat request automatically.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$The separate microphone starts <strong>Dictate message</strong> after browser permission. Speak, then choose Finish to convert the recording into one editable transcript. Cancel discards pending dictation. It is not a voice attachment, and nothing is sent to Mink until you press Send. HTTPS and browser audio support are required; otherwise type your request.$old$,
      $new$The separate microphone starts <strong>Dictate message</strong> after browser permission. Speak normally, then pause briefly; StoreMink detects that you have finished and puts one editable transcript in the message box. Cancel discards pending dictation. It is not a voice attachment, and nothing is sent to Mink until you press Send. HTTPS and browser audio support are required; otherwise type your request.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$For a product promotion, Mink keeps your product photo intact and puts offer wording in the editable carousel text.$old$,
      $new$For a product promotion, Mink uses the image you attached or searches the named product in your catalogue and uses its authentic product photo. It keeps that photo intact and puts offer wording in the editable carousel text.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$The newest remaining conversation is restored after a dashboard refresh, and starting an eleventh conversation automatically removes the oldest one.$old$,
      $new$The newest remaining conversation is restored after a dashboard refresh. Starting a new conversation keeps the newest ten visible. Ordinary overflow is removed automatically; an older conversation tied to a retained publication or completed action stays safely outside the recent list instead of blocking the new conversation.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published';
