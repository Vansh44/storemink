"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CODE_HEIGHT_MAX,
  CODE_HEIGHT_MIN,
  type CustomCodeConfig,
} from "@/lib/homepage/section-types";
import {
  MINK_STOREFRONT_BROWSER_ISSUES,
  type MinkStorefrontBrowserFrameResult,
  type MinkStorefrontBrowserViewport,
} from "@/lib/mink/storefront-publication-types";

// ---------------------------------------------------------------------------
// Sandboxed renderer for merchant-authored HTML/CSS/JS.
//
// SECURITY MODEL — do not weaken:
//  • Live sections use sandbox="allow-scripts allow-popups"; strict Mink
//    previews use only "allow-scripts". NEVER add "allow-same-origin".
//    Supabase auth cookies are httpOnly:false with Domain=.storemink.com, so
//    same-origin merchant JS could read a visitor's session that is valid on
//    EVERY store subdomain and the platform. The srcDoc iframe gets an opaque
//    origin instead: no cookies, no storage, no parent DOM.
//  • No allow-top-navigation: a section must not be able to redirect visitors.
//    <base target="_blank"> keeps merchant links working (new tab).
//  • The only channel out is postMessage; the parent accepts ONLY a height
//    number from its own iframe's contentWindow, clamped to sane bounds.
//  • If a CSP is ever added to the app, note srcDoc frames INHERIT the
//    embedder's CSP — carve out inline script/style for these frames; the
//    sandbox attribute (not CSP) is the actual security boundary here.
// ---------------------------------------------------------------------------

// Prevent merchant strings from closing our wrapper tags and escaping into the
// document we compose (classic "</script>" breakout).
function escapeScriptClose(js: string): string {
  return js.replace(/<\/(script)/gi, "<\\/$1");
}
function escapeStyleClose(css: string): string {
  return css.replace(/<\/(style)/gi, "<\\/$1");
}

// Reports the content height to the parent. Runs inside the sandbox, so
// `parent.postMessage(..., "*")` is required (an opaque-origin frame cannot
// name its parent's origin) and safe (payload is just a number + marker).
//
// Measures document.body (not documentElement): the <html> element's
// scrollHeight is floored at the iframe's own viewport height, so using it
// would trap the frame at its initial fallback height and never let it shrink
// to fit shorter content. The body height is `auto`, so it shrink-wraps.
const RESIZE_SNIPPET = `(function(){
  var send=function(){
    var b=document.body;if(!b)return;
    var h=Math.max(b.scrollHeight,b.offsetHeight);
    parent.postMessage({source:"sm-cc",height:h},"*");
  };
  if(window.ResizeObserver){var ro=new ResizeObserver(send);ro.observe(document.body);}
  window.addEventListener("load",send);
  setTimeout(send,60);setTimeout(send,600);
})();`;

const STRICT_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

function buildSrcDoc(
  config: CustomCodeConfig,
  strictNetworkIsolation: boolean,
  validation?: {
    token: string;
    viewport: MinkStorefrontBrowserViewport;
    width: number;
  },
): string {
  const parts = [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    strictNetworkIsolation
      ? `<meta http-equiv="Content-Security-Policy" content="${STRICT_PREVIEW_CSP}">`
      : "",
    "<style>html,body{margin:0;padding:0}</style>",
    config.css ? `<style>${escapeStyleClose(config.css)}</style>` : "",
    strictNetworkIsolation
      ? "</head><body>"
      : '<base target="_blank"></head><body>',
    config.html,
    validation
      ? buildValidationScript(config.js, validation)
      : config.js
        ? `<script>try{${escapeScriptClose(config.js)}\n}catch(e){console.error("[custom code]",e)}</script>`
        : "",
    config.height_mode === "auto" ? `<script>${RESIZE_SNIPPET}</script>` : "",
    "</body></html>",
  ];
  return parts.join("");
}

function buildValidationScript(
  merchantJavaScript: string,
  validation: {
    token: string;
    viewport: MinkStorefrontBrowserViewport;
    width: number;
  },
) {
  const token = JSON.stringify(validation.token);
  const viewport = JSON.stringify(validation.viewport);
  const width = JSON.stringify(validation.width);
  return `<script>(function(){
  "use strict";
  var smRuntimeErrors=0,smCspViolations=0;
  var smLater=window.setTimeout.bind(window);
  var smPost=window.parent.postMessage.bind(window.parent);
  window.addEventListener("error",function(){smRuntimeErrors+=1;});
  window.addEventListener("unhandledrejection",function(){smRuntimeErrors+=1;});
  document.addEventListener("securitypolicyviolation",function(){smCspViolations+=1;});
  try{${escapeScriptClose(merchantJavaScript)}\n}catch(e){smRuntimeErrors+=1;}
  smLater(function(){
    var issues=[];
    function add(value){if(issues.indexOf(value)<0)issues.push(value);}
    function nameOf(node){return ((node.getAttribute("aria-label")||"")+" "+(node.getAttribute("aria-labelledby")||"")+" "+(node.textContent||"")).trim();}
    Array.prototype.forEach.call(document.querySelectorAll("img"),function(node){if(!node.hasAttribute("alt"))add("missing_image_alt");});
    Array.prototype.forEach.call(document.querySelectorAll("button"),function(node){if(!nameOf(node))add("missing_button_name");});
    Array.prototype.forEach.call(document.querySelectorAll("a"),function(node){if(!nameOf(node))add("missing_link_name");});
    Array.prototype.forEach.call(document.querySelectorAll("input:not([type=hidden]),select,textarea"),function(node){var id=node.id;var labelled=node.getAttribute("aria-label")||node.getAttribute("aria-labelledby")||(id&&document.querySelector('label[for="'+CSS.escape(id)+'"]'));if(!labelled)add("missing_form_label");});
    var ids=Object.create(null);Array.prototype.forEach.call(document.querySelectorAll("[id]"),function(node){if(ids[node.id])add("duplicate_id");ids[node.id]=true;});
    var previous=0;Array.prototype.forEach.call(document.querySelectorAll("h1,h2,h3,h4,h5,h6"),function(node){var level=Number(node.tagName.slice(1));if(previous&&level>previous+1)add("invalid_heading_order");previous=level;});
    Array.prototype.forEach.call(document.querySelectorAll("[tabindex]"),function(node){if(Number(node.getAttribute("tabindex"))>0)add("positive_tabindex");});
    Array.prototype.forEach.call(document.querySelectorAll('a[aria-hidden="true"],button[aria-hidden="true"],input[aria-hidden="true"],select[aria-hidden="true"],textarea[aria-hidden="true"]'),function(){add("hidden_focus_target");});
    var overflow=document.documentElement.scrollWidth>document.documentElement.clientWidth+1||document.body.scrollWidth>document.body.clientWidth+1;
    if(overflow)add("horizontal_overflow");
    if(smRuntimeErrors)add("runtime_error");if(smCspViolations)add("csp_violation");
    smPost({source:"sm-cc-validation",token:${token},viewport:${viewport},width:${width},passed:issues.length===0,issues:issues,runtimeErrorCount:smRuntimeErrors,cspViolationCount:smCspViolations,horizontalOverflow:overflow},"*");
  },500);
})();</script>`;
}

export function CustomCodeFrame({
  config,
  title = "Custom section",
  strictNetworkIsolation = false,
  validation,
}: {
  config: CustomCodeConfig;
  title?: string;
  /** Phase 7B previews allow inline proposal code but no external resources. */
  strictNetworkIsolation?: boolean;
  /** Phase 7D runs this bounded report inside the opaque preview frame. */
  validation?: {
    token: string;
    viewport: MinkStorefrontBrowserViewport;
    width: number;
    onResult: (result: MinkStorefrontBrowserFrameResult) => void;
  };
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [autoHeight, setAutoHeight] = useState<number | null>(null);
  const validationToken = validation?.token;
  const validationViewport = validation?.viewport;
  const validationWidth = validation?.width;
  const validationOnResult = validation?.onResult;

  const srcDoc = useMemo(
    () =>
      buildSrcDoc(
        config,
        strictNetworkIsolation,
        validationToken && validationViewport && validationWidth
          ? {
              token: validationToken,
              viewport: validationViewport,
              width: validationWidth,
            }
          : undefined,
      ),
    [
      config,
      strictNetworkIsolation,
      validationToken,
      validationViewport,
      validationWidth,
    ],
  );

  useEffect(() => {
    if (config.height_mode !== "auto") return;
    function onMessage(event: MessageEvent) {
      // Only our own frame, only our marker, only a numeric height.
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { source?: string; height?: unknown };
      if (data?.source !== "sm-cc" || typeof data.height !== "number") return;
      const clamped = Math.min(
        CODE_HEIGHT_MAX,
        Math.max(CODE_HEIGHT_MIN, Math.ceil(data.height)),
      );
      setAutoHeight(clamped);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [config.height_mode]);

  useEffect(() => {
    if (
      !validationToken ||
      !validationViewport ||
      !validationWidth ||
      !validationOnResult
    )
      return;
    const activeValidation = {
      token: validationToken,
      viewport: validationViewport,
      width: validationWidth,
      onResult: validationOnResult,
    };
    function onValidationMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as Partial<MinkStorefrontBrowserFrameResult> & {
        source?: unknown;
      };
      if (
        data?.source !== "sm-cc-validation" ||
        data.token !== validationToken ||
        data.viewport !== validationViewport ||
        data.width !== validationWidth ||
        typeof data.passed !== "boolean" ||
        !Array.isArray(data.issues) ||
        !data.issues.every((issue) =>
          MINK_STOREFRONT_BROWSER_ISSUES.includes(issue),
        ) ||
        !Number.isInteger(data.runtimeErrorCount) ||
        !Number.isInteger(data.cspViolationCount) ||
        typeof data.horizontalOverflow !== "boolean"
      ) {
        return;
      }
      activeValidation.onResult({
        token: activeValidation.token,
        viewport: activeValidation.viewport,
        width: activeValidation.width,
        passed: data.passed,
        issues: data.issues,
        runtimeErrorCount: Number(data.runtimeErrorCount),
        cspViolationCount: Number(data.cspViolationCount),
        horizontalOverflow: data.horizontalOverflow,
      });
    }
    window.addEventListener("message", onValidationMessage);
    return () => window.removeEventListener("message", onValidationMessage);
  }, [
    validationOnResult,
    validationToken,
    validationViewport,
    validationWidth,
  ]);

  const height =
    config.height_mode === "fixed"
      ? config.fixed_height
      : (autoHeight ?? config.fixed_height);

  return (
    <iframe
      ref={iframeRef}
      sandbox={
        strictNetworkIsolation ? "allow-scripts" : "allow-scripts allow-popups"
      }
      srcDoc={srcDoc}
      title={title}
      loading="lazy"
      // ★ STRICT PREVIEWS ONLY. A live section has no CSP, so merchant HTML/JS
      // may legitimately load third-party resources — and a srcdoc document
      // inherits this element's referrer policy, so applying it here would
      // strip `Referer` from those requests. Google Maps, reCAPTCHA and
      // hotlink-protected CDNs restrict keys BY referrer, so an existing,
      // working custom-code section would silently start failing. Phase 7B/7D
      // previews block the network outright, so there the policy costs nothing.
      referrerPolicy={strictNetworkIsolation ? "no-referrer" : undefined}
      style={{ width: "100%", height, border: 0, display: "block" }}
    />
  );
}
