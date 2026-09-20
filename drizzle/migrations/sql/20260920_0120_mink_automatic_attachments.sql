-- Sending a visible attachment is now the single processing action. Replace
-- the old consent/review instructions in place and explain the two merchant
-- outcomes that depend on retaining the exact uploaded image.

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<p>One control adds files: choose <strong>+ (Add image or document)</strong>, or drop a file onto the message box. Short UTF-8 text and Markdown files are read on your own device; images and PDFs are extracted only after you consent. Spreadsheets, audio files, external web addresses and automatic document processing are not supported, and the microphone is for dictation rather than an audio attachment. Invalid encoding, binary content and oversized files are refused rather than quietly shortened. Use Discard to remove a file you have not added yet, or edit the message before sending.</p>$old$,
      $new$<p>Choose <strong>+ (Add image or document)</strong>, or drop one supported file onto the message box. An image appears as a compact square preview; choose it to see the full picture, or use its close button to remove it before sending. Press <strong>Send</strong> once to process the visible attachment with your request. There is no separate attachment approval box. Short UTF-8 text and Markdown files are read on your device; images and PDFs are read by StoreMink's AI provider. Spreadsheets, audio files, external web addresses and long documents are not supported, and the microphone is for dictation rather than an audio attachment.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<p>Choose + (Add image or document) near the composer for one UTF-8 .txt or .md file up to 8 KiB and 3,000 characters. The file is read locally. Review and edit the text, remove sensitive information, tick its checkbox, then choose Add reviewed text to message. Nothing is sent until you send the resulting message. The combined message must fit 4,000 characters. The reviewed text is labelled untrusted source data and retained with the conversation under its existing history/deletion rules; it is not saved as a memory, media upload or searchable document library. Markdown and instruction-like content are text, not authority to call tools or approve actions. Files cannot silently change stock, send messages or publish a storefront.</p>$old$,
      $new$<p>Choose + (Add image or document) near the composer for one UTF-8 .txt or .md file up to 8 KiB and 3,000 characters. The file is read locally and appears as a removable file card. Remove sensitive information before attaching it, then press Send once to include its text with your request. The combined message must fit 4,000 characters. The text is labelled untrusted source data and retained with the conversation under its existing history/deletion rules; it is not saved as a memory, media upload or searchable document library. Markdown and instruction-like content are text, not authority to call tools or approve actions. Files cannot silently change stock, send messages or publish a storefront.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<p>Use <strong>+ (Add image or document)</strong> or drop one supported image, PDF, text or Markdown file onto the message box for review. The separate microphone starts <strong>Dictate message</strong> after browser permission. Speak normally, then pause briefly; StoreMink detects that you have finished and puts one editable transcript in the message box. Cancel discards pending dictation. It is not a voice attachment, and nothing is sent to Mink until you press Send. HTTPS and browser audio support are required; otherwise type your request.</p>$old$,
      $new$<p>Use <strong>+ (Add image or document)</strong> or drop one supported image, PDF, text or Markdown file onto the message box. The separate microphone starts <strong>Dictate message</strong> after browser permission. Speak normally, then pause briefly; StoreMink detects that you have finished and puts one editable transcript in the message box. Cancel discards pending dictation. It is not a voice attachment, and nothing is sent to Mink until you press Send. HTTPS and browser audio support are required; otherwise type your request.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<p>Remove secrets and unnecessary customer details first. Check the processing consent box and choose <strong>Process for review</strong>. This sends the file to StoreMink's AI provider before you send a chat message. Processing for review keeps no copy of the file: it does not become a media item or a saved memory, though the provider's retention policies still apply. Keeping an image is a separate, deliberate step. Choose <strong>Save to Media Library</strong> beside the attachment and the picture is stored in your own Media library exactly as if you had uploaded it there, and its address is added to your message so Mink can use it straight away. Processing and saving are independent: do either, both or neither. Cancelling cannot retract bytes already sent to the provider.</p>$old$,
      $new$<p>Remove secrets and unnecessary customer details before sending. Pressing <strong>Send</strong> with a visible image or PDF sends that attachment to StoreMink's AI provider for a bounded reading; provider retention policies still apply. A sent image is also saved in your Media library when your role can add Media, so the exact picture can appear in conversation history and be used for the request. A PDF is not saved as a Media item. Attaching a file does not save a memory or approve a product, storefront or other business change.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$After a failure, wait and explicitly approve another attempt; provider work from a timed-out request might still have incurred usage.$old$,
      $new$After a failure, wait and press Send again when you are ready to retry; provider work from a timed-out request might still have incurred usage.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<p>Review and correct extracted image or PDF text because it can omit or misread details; it is not a verified stock level or action approval. Confirm the reviewed text, then choose <strong>Add reviewed reference to message</strong>. Dictated words are already editable in the message box. Nothing is sent to the chatbot until you press Send. Extraction is limited to 3,000 characters and the combined chat message remains limited to 4,000 characters. Chat and follow-up turns receive only the reviewed text, not the original image or PDF.</p>$old$,
      $new$<p>Mink receives the isolated reading as untrusted reference context and uses it only for the request you typed. Image and PDF reading can omit or misread details; a screenshot is not a verified stock level or action approval. When you ask to create a product from an attached product photo, Mink carries that exact saved image into the private product proposal. When you attach a screenshot of your own storefront and ask for a change, Mink combines the visual reading with the current Website Builder state before preparing the normal private proposal. You still review and approve any product or storefront change separately. Extraction is limited to 3,000 characters and the combined chat message remains limited to 4,000 characters.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$For other image or document questions, open the preview card and review the extracted text before adding it to your message; that review does not save the original file.$old$,
      $new$For other image or document questions, press Send once; Mink processes the visible attachment with your request and shows it with the sent message.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$A file selected with the plus button appears as a removable preview card in your message.$old$,
      $new$A file selected with the plus button appears as a removable preview in your message. Images use a compact square; choose one to view it at full size.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published';
