import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { kindOf } from "@/lib/hq/bots/attachments";
import { getChatAttachment } from "@/lib/hq/data";

/**
 * A file attached in the Team room, for its thumbnail or to open it. Served
 * as the type its bytes were checked to be, and cached only by the browser.
 */
async function handleGet(request: Request, context: RouteContext<"/api/chat/attachments/[id]">) {
  const { id } = await context.params;
  const attachment = getChatAttachment(id);
  if (!attachment) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const download = new URL(request.url).searchParams.has("download");
  // Text is shown as plain text whatever its extension, so nothing renders as a page.
  const type = kindOf(attachment.mediaType) === "text" ? "text/plain; charset=utf-8" : attachment.mediaType;
  return new Response(new Uint8Array(attachment.data), {
    headers: {
      "Content-Type": type,
      "Content-Length": String(attachment.data.byteLength),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
      // Chrome's PDF viewer won't open in a sandboxed document; images and text can.
      ...(attachment.mediaType === "application/pdf" ? {} : { "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" }),
      "Cache-Control": "private, max-age=3600",
    },
  });
}

export const GET = withSession(handleGet);
