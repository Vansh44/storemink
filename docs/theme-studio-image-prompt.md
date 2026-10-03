# Theme Studio image prompt

This document is the executable prompt Theme Studio sends to its image model
(`lib/theme-studio/image-models.ts`) for every generated theme image.
`lib/theme-studio/image-prompt.ts` reads the marked text fence at runtime,
validates its four placeholders and fills them from the theme's Stage A intent,
its compiled palette and one asset brief.

It is a separate document from `docs/mink-ai-image-prompt.md` on purpose. Mink
makes one marketing image for a merchant's real product; Theme Studio makes a
coherent SET of demonstration images for a theme that has no real products, so
it must invent believable, unbranded goods and keep every image in one visual
language.

Provider safety settings, the people block, the aspect ratio, the output size
and format, and the retry policy are enforced in code
(`lib/theme-studio/image-vertex.ts`) because they must not be editable through
prompt text.

<!-- THEME_STUDIO_IMAGE_PROMPT_START -->

```text
Create one finished photograph for a demonstration storefront theme. It is one image in a set: every image in the theme must look like it came from the same shoot and the same art director.

THEME DIRECTION
{{theme_direction}}

THIS IMAGE
{{asset_brief}}

COMPOSITION
{{composition}}

REFERENCE IMAGES
{{reference_guidance}}

SET RULES
1. Follow the theme direction for mood, palette, light, surfaces, materials and camera style. When it describes the photography of the operator's reference screenshots, match that photographic approach (setting, styling, light, crop and product presentation) while inventing your own products: never reproduce a specific photograph, product or brand from the references. The palette colours are the theme's own. When THIS IMAGE names a background colour, gradient or coloured set, use it fully and boldly; otherwise let the backdrop, props and grade sit comfortably with the palette.
2. The goods are fictional demonstration products for a theme preview. Invent believable, well-made, unbranded products that fit the store's industry. Never depict a real brand, a recognisable trademarked design, a celebrity product or a competitor's packaging.
3. Photograph real-looking physical objects with believable scale, contact shadows, reflections and material texture. It must look shot, not rendered or pasted.
4. Keep the whole subject inside the crop-safe area described in the composition, with breathing room on every edge, and extend the background naturally so a responsive crop never cuts the subject.
5. When a style anchor is supplied, match its lighting quality, lens, colour grade, surface materials and prop style so the set reads as one shoot. THIS IMAGE's own background colour or gradient takes precedence over the anchor's backdrop: a hero, banner, category or editorial image that asks for a magenta-to-lime gradient or a coral set gets it, even when the anchor was shot on white. Keep this image's subject and product identity. Do not substitute warm limestone or a dark wooden table for a bright white/concrete anchor merely because the asset brief mentions those surfaces.
6. Catalogue pack shots use a different composition from the style anchor: the first product establishes a plain, uninterrupted backdrop without copying anchor props, plinths or room staging. When SET is supplied, that validated product photograph takes precedence over ANCHOR and conflicting brief details for backdrop, camera, light, framing and subject scale. Keep that same setup and replace the product, adapting its pose to show its full shape. ANCHOR supplies complementary palette and mood; it must not introduce a different platform, border, backdrop or scene.

OUTPUT RULES
- One photograph only: not a collage, grid, contact sheet, split panel, mockup frame or design board.
- No text of any kind in the pixels: no headlines, captions, prices, labels with words, logos, monograms, watermarks, signatures or UI. Packaging should carry wordless label artwork that suits the product, so it looks like a real finished product rather than a blank mockup: colour blocks, patterns, illustrations, botanical or abstract shapes. Never letters, numbers, words, logos, monograms or symbols that read as a brand mark, whether printed, embossed or engraved.
- No people, faces, hands or body parts, and no mannequins or forms with faces. If THIS IMAGE mentions a model, a person, hands or someone wearing the product, show the product on its own instead: garments flat-lay, on a hanger, folded or draped; footwear and bags on a plinth or step; lifestyle scenes as empty, styled rooms and places where the products are the subject.
- Crisp commercial quality: sharp edges, clean tonal detail, no blur, no compression artefacts, no smeared shapes, no obvious upscaling.
- Avoid duplicated or malformed objects, floating items, clipped subjects and unrelated clutter.

Return exactly one image.
```

<!-- THEME_STUDIO_IMAGE_PROMPT_END -->

## Editing contract

- Keep exactly one ordered marker pair and one `text` code fence.
- Keep `{{theme_direction}}`, `{{asset_brief}}`, `{{composition}}` and
  `{{reference_guidance}}` exactly once each and add no other placeholders.
- Do not add Markdown formatting inside the marked prompt.
- The file ships with the server: it is listed in `next.config.ts`
  `outputFileTracingIncludes` and excepted in `.dockerignore`.
- Run `npx vitest run lib/theme-studio/image-prompt.test.ts` after any change.
