-- The composer now accepts five independently bounded files, uploads permitted
-- images at selection time, and generates sharper crop-safe campaign artwork.
-- Edit the existing task guidance in place; do not append a release note.

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<p>Choose <strong>+ (Add image or document)</strong>, or drop one supported file onto the message box. An image appears as a compact square preview; choose it to see the full picture, or use its close button to remove it before sending. Press <strong>Send</strong> once to process the visible attachment with your request. There is no separate attachment approval box. Short UTF-8 text and Markdown files are read on your device; images and PDFs are read by StoreMink's AI provider. Spreadsheets, audio files, external web addresses and long documents are not supported, and the microphone is for dictation rather than an audio attachment.</p>$old$,
      $new$<p>Choose <strong>+ (Add image or document)</strong>, or drop up to five supported files onto the message box. Images appear as compact square previews; choose one to see the full picture, or use its close button to remove it before sending. Press <strong>Send</strong> once to process the visible attachments with your request. There is no separate attachment approval box. Short UTF-8 text and Markdown files are read on your device; images and PDFs are read by StoreMink's AI provider. Spreadsheets, audio files, external web addresses and long documents are not supported, and the microphone is for dictation rather than an audio attachment.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<p>Choose + (Add image or document) near the composer for one UTF-8 .txt or .md file up to 8 KiB and 3,000 characters. The file is read locally and appears as a removable file card. Remove sensitive information before attaching it, then press Send once to include its text with your request. The combined message must fit 4,000 characters. The text is labelled untrusted source data and retained with the conversation under its existing history/deletion rules; it is not saved as a memory, media upload or searchable document library. Markdown and instruction-like content are text, not authority to call tools or approve actions. Files cannot silently change stock, send messages or publish a storefront.</p>$old$,
      $new$<p>Choose + (Add image or document) near the composer for UTF-8 .txt or .md files up to 8 KiB and 3,000 characters each. Each file is read locally and appears as a removable file card. Remove sensitive information before attaching it, then press Send once to include the text with your request. The combined message and attachment references must fit 12,000 characters. The text is labelled untrusted source data and retained with the conversation under its existing history/deletion rules; it is not saved as a memory, media upload or searchable document library. Markdown and instruction-like content are text, not authority to call tools or approve actions. Files cannot silently change stock, send messages or publish a storefront.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<p>Use <strong>+ (Add image or document)</strong> or drop one supported image, PDF, text or Markdown file onto the message box. The separate microphone starts <strong>Dictate message</strong> after browser permission.$old$,
      $new$<p>Use <strong>+ (Add image or document)</strong> or drop up to five supported images, PDFs, text or Markdown files onto the message box. The separate microphone starts <strong>Dictate message</strong> after browser permission.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<p>Each file must be no larger than <strong>2 MiB</strong>. Images support single-frame PNG, JPEG or WebP up to 12 megapixels; StoreMink strips image metadata and resizes them to at most 1600 pixels per side. PDFs support up to <strong>10 pages</strong>; encrypted, damaged, active-content or form PDFs are rejected. The same <strong>+ (Add image or document)</strong> control takes short UTF-8 text or Markdown files up to 8 KiB, which are read on your own device rather than sent for extraction. Audio files, video, spreadsheets and long documents are not supported: the microphone is live dictation, not an attachment.</p>$old$,
      $new$<p>Each image or PDF must be no larger than <strong>5 MiB</strong>, and one message can carry up to five files. Images support single-frame PNG, JPEG or WebP up to 12 megapixels; StoreMink strips image metadata and resizes them to at most 1600 pixels per side for reading. PDFs support up to <strong>10 pages</strong>; encrypted, damaged, active-content or form PDFs are rejected. The same <strong>+ (Add image or document)</strong> control takes short UTF-8 text or Markdown files up to 8 KiB, which are read on your own device rather than sent for extraction. Audio files, video, spreadsheets and long documents are not supported: the microphone is live dictation, not an attachment.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<p>Remove secrets and unnecessary customer details before sending. Pressing <strong>Send</strong> with a visible image or PDF sends that attachment to StoreMink's AI provider for a bounded reading; provider retention policies still apply. A sent image is also saved in your Media library when your role can add Media, so the exact picture can appear in conversation history and be used for the request. A PDF is not saved as a Media item. Attaching a file does not save a memory or approve a product, storefront or other business change.</p>$old$,
      $new$<p>Remove secrets and unnecessary customer details before attaching a file. When your role can add Media, each selected image starts uploading immediately so it is ready in the conversation and can be used by the request; remove its preview before sending if you do not want to keep it. Pressing <strong>Send</strong> sends each visible image or PDF to StoreMink's AI provider for a bounded reading; provider retention policies still apply. PDFs are not saved as Media items. Attaching files does not save a memory or approve a product, storefront or other business change.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$Extraction is limited to 3,000 characters and the combined chat message remains limited to 4,000 characters.$old$,
      $new$Each reading is bounded, with shorter readings when several files share one request; the combined chat message and attachment references remain limited to 12,000 characters.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$For other image or document questions, press Send once; Mink processes the visible attachment with your request and shows it with the sent message.$old$,
      $new$For other image or document questions, press Send once; Mink processes the visible attachments with your request and shows them with the sent message.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$A file selected with the plus button appears as a removable preview in your message. Images use a compact square; choose one to view it at full size.$old$,
      $new$Files selected with the plus button appear as removable previews in your message. Images use compact squares; choose one to view it at full size. Attachment errors disappear automatically after a few seconds.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$Mink first checks the relevant pictures you can access. It uses an exact matching product, category or Media image as visual reference when one is available, so the new artwork follows the subject you named rather than substituting an unrelated one. Product and offer wording stays editable on the page instead of being added to the picture.$old$,
      $new$Mink first checks the relevant pictures you can access. It uses an exact matching product, category or Media image as visual reference when one is available, so the new artwork follows the subject you named rather than substituting an unrelated one. Mink composes sharp, purpose-shaped campaign artwork around that reference, keeps the complete product inside a responsive crop-safe area, and uses the offer or occasion to guide the setting, props, lighting and visual energy instead of simply pasting a cutout onto a background. Product and offer wording stays editable on the page instead of being added to the picture.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';
