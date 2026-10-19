import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encryptCredential } from "@qianliu/provider-adapters";
import { WecomAppClient, parseReportReceipt, type EndpointConfig } from "../wecom-client.js";

const kek=Buffer.alloc(32,7), key=kek.toString("base64");
const endpoint: EndpointConfig={ id:"test",corp_id:"corp",agent_id:"100",secret_ciphertext:JSON.stringify(encryptCredential("fixture-secret",kek)),secret_fingerprint:"fixture" };
let server: Server, origin: string;
let reply: unknown={errcode:0,msgid:"receipt"}, drop=false, tokenRequests=0, messageRequests=0;
const uploads: Array<{ bytes: Buffer; filename: string; length: number; headerLength: number }> = [];
beforeAll(async()=>{
  server=createServer(async(req,res)=>{
    if(req.url?.startsWith("/cgi-bin/gettoken")) { tokenRequests++;res.end(JSON.stringify({errcode:0,access_token:"fixture-token"}));return; }
    if(req.url?.startsWith("/cgi-bin/media/upload")) {
      const buffers=[];for await(const chunk of req)buffers.push(Buffer.from(chunk));
      const body=Buffer.concat(buffers);
      const request=new Request("http://local/upload",{method:"POST",headers:{"content-type":req.headers["content-type"]!},
        // Node 22's formData decoder rejects WeCom's filelength extension. Verify it,
        // then normalize only that header parameter for the independent multipart decoder.
        body:Buffer.from(body.toString("latin1").replace(/; filelength=\d+\r\n/,"\r\n"),"latin1")});
      expect(body.toString("latin1")).toMatch(/; filelength=\d+\r\nContent-Type: image\/png/);
      const form=await request.formData(), file=form.get("media") as File;
      uploads.push({bytes:Buffer.from(await file.arrayBuffer()),filename:file.name,length:body.length,headerLength:Number(req.headers["content-length"])});
      res.end(JSON.stringify({errcode:0,media_id:"media-fresh"}));return;
    }
    messageRequests++;
    if(drop) { req.socket.destroy();return; }
    res.end(JSON.stringify(reply));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();if(!address||typeof address==="string")throw new Error("missing listener");
  origin=`http://127.0.0.1:${address.port}`;
});
afterAll(()=>new Promise<void>((resolve,reject)=>{server.closeAllConnections();server.close(error=>error?reject(error):resolve());}));
const localFetch: typeof fetch=(url,init)=>fetch(new URL(new URL(url instanceof Request?url.url:String(url)).pathname,origin),init);

describe("report real HTTP transport",()=>{
  it.each([16,4096,100_000])("uploads correct multipart bytes and UTF8 filename at %i bytes",async(size)=>{
    const bytes=Buffer.alloc(size,0x88);
    const client=new WecomAppClient(key,(url,init)=>{
      if(String(url).includes("media/upload")) expect(new Headers(init?.headers).has("Content-Length")).toBe(false);
      return localFetch(url,init);
    });
    expect(await client.uploadMedia(endpoint,bytes,"团队周报.png")).toBe("media-fresh");
    const upload=uploads.at(-1)!;
    expect(upload.bytes).toEqual(bytes);expect(upload.filename).toBe("团队周报.png");expect(upload.headerLength).toBe(upload.length);
  });
  it("HTTP200 errors are failures; actual message request is never nested on token rejection",async()=>{
    const client=new WecomAppClient(key,localFetch);
    const before=messageRequests, tokens=tokenRequests;reply={errcode:40014};
    expect((await client.sendReportMessage(endpoint,"user",{kind:"TEXT",content:"summary"})).status).toBe("RETRYABLE_FAILED");
    expect(messageRequests-before).toBe(1);
    reply={errcode:0,msgid:"ok"};
    expect((await client.sendReportMessage(endpoint,"user",{kind:"TEXT",content:"summary"})).status).toBe("SENT");
    expect(tokenRequests-tokens).toBe(2);
  });
  it("accepted request with disconnected response becomes UNKNOWN",async()=>{
    drop=true;
    try { expect((await new WecomAppClient(key,localFetch).sendReportMessage(endpoint,"user",{kind:"TEXT",content:"summary"})).status).toBe("UNKNOWN"); }
    finally { drop=false; }
  });
  it("window closing during preparation prevents the message request",async()=>{
    const before=messageRequests;
    expect((await new WecomAppClient(key,localFetch).sendReportMessage(endpoint,"user",{kind:"TEXT",content:"summary"},async()=>false)).classification).toBe("SEND_GUARD_CLOSED");
    expect(messageRequests).toBe(before);
  });
  it("missing token/media fields cannot masquerade as message success",async()=>{
    const tokenClient=new WecomAppClient(key,async()=>new Response(JSON.stringify({errcode:0})));
    expect((await tokenClient.sendReportMessage(endpoint,"user",{kind:"TEXT",content:"summary"})).status).toBe("PERMANENT_FAILED");
    const mediaClient=new WecomAppClient(key,async url=>new Response(JSON.stringify(String(url).includes("gettoken")?{errcode:0,access_token:"fixture"}:{errcode:0})));
    await expect(mediaClient.uploadMedia(endpoint,Buffer.from("fixture-image"))).rejects.toMatchObject({result:{status:"PERMANENT_FAILED",classification:"WECOM_INVALID_MEDIA_RECEIPT"}});
  });

});
describe("receipt attribution",()=>{
  it.each([{}, {errmsg:"ok"}, {errcode:0}, {errcode:0,msgid:"ok",invaliduser:42}])("rejects incomplete protocol %j",response=>{
    expect(parseReportReceipt(response as never,"user").status).toBe("UNKNOWN");
  });
  it("attributes rejected and unlicensed users case-insensitively",()=>{
    for(const field of ["invaliduser","unlicenseduser"])expect(parseReportReceipt({errcode:0,msgid:"ok",[field]:"USER"},"user").status).toBe("PERMANENT_FAILED");
    expect(parseReportReceipt({errcode:0,msgid:"ok",invaliduser:"other"},"user").status).toBe("UNKNOWN");
  });
  it("preserves batch recipient rejections without claiming SENT",async()=>{
    reply={errcode:0,msgid:"ok",invaliduser:"bad"};
    const result=await new WecomAppClient(key,localFetch).sendTextMessage(endpoint,["good","bad"],"summary");
    expect(result.status).toBe("PERMANENT_FAILED");expect(result.invalidRecipients).toEqual(["bad"]);
  });
  it("preserves retryable protocol failures for legacy alert callers",async()=>{
    const malformedFetch:typeof fetch=async url=>new Response(JSON.stringify(String(url).includes("gettoken")
      ? {errcode:0,access_token:"fixture-token"} : {errmsg:"incomplete receipt"}));
    const client=new WecomAppClient(key,malformedFetch);
    expect(await client.sendTextMessage(endpoint,["user"],"existing alert")).toMatchObject({
      status:"RETRYABLE_FAILED",classification:"WECOM_INVALID_RECEIPT",
    });
    expect(await client.sendReportMessage(endpoint,"user",{kind:"TEXT",content:"report summary"})).toMatchObject({
      status:"UNKNOWN",classification:"WECOM_INVALID_RECEIPT",
    });
  });

});
