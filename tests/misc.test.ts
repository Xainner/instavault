import { describe, expect, it } from "vitest";
import { classifyJson, parseJsonLoose } from "../src/main/ig/classify";
import { cdnExpiry, isAllowedCdnUrl, isExpired } from "../src/main/ig/cdn";
import { parseInstagramUrl, shortcodeToMediaId } from "../src/main/ig/url";
import { parseRange } from "../src/main/vault/range";
import { VaultError } from "../src/main/errors";

describe("enlaces de Instagram", () => {
  it("reconoce publicaciones, reels, stories, highlights y perfiles", () => {
    expect(parseInstagramUrl("https://www.instagram.com/p/C9xYz12AbCd/?igsh=abc")).toMatchObject({ type: "post", shortcode: "C9xYz12AbCd" });
    expect(parseInstagramUrl("instagram.com/reel/DAbc_123/")).toMatchObject({ type: "post", shortcode: "DAbc_123" });
    expect(parseInstagramUrl("https://www.instagram.com/someone/p/QWERTY12/")).toMatchObject({ type: "post", shortcode: "QWERTY12" });
    expect(parseInstagramUrl("https://www.instagram.com/stories/demo.user/3312345678901234567/")).toMatchObject({
      type: "story",
      username: "demo.user",
      storyId: "3312345678901234567",
    });
    expect(parseInstagramUrl("https://www.instagram.com/stories/highlights/17912345678901234/")).toMatchObject({ type: "highlight", highlightId: "17912345678901234" });
    expect(parseInstagramUrl("@Demo.User")).toMatchObject({ type: "profile", username: "demo.user" });
    expect(parseInstagramUrl("https://www.instagram.com/demo_user/")).toMatchObject({ type: "profile", username: "demo_user" });
    expect(parseInstagramUrl("https://example.com/p/abc")).toBeNull();
    expect(parseInstagramUrl("https://www.instagram.com/explore/")).toBeNull();
  });

  it("convierte shortcode a id numérico", () => {
    expect(shortcodeToMediaId("B")).toBe("1");
    expect(shortcodeToMediaId("BA")).toBe("64");
    expect(shortcodeToMediaId("B$")).toBeNull();
  });
});

describe("URLs de la CDN", () => {
  it("lee la expiración oe y aplica margen", () => {
    const url = "https://scontent-mad1-1.cdninstagram.com/v/t51/x.jpg?stp=a&oe=6700A1B2&_nc=1";
    expect(cdnExpiry(url)).toBe(0x6700a1b2);
    expect(isExpired(0x6700a1b2, 0x6700a1b2 - 60)).toBe(true);
    expect(isExpired(0x6700a1b2, 0x6700a1b2 - 3600)).toBe(false);
    expect(cdnExpiry("https://cdn/x.jpg")).toBeNull();
  });

  it("sólo permite hosts de la CDN por https", () => {
    expect(isAllowedCdnUrl("https://scontent.cdninstagram.com/a.jpg")).toBe(true);
    expect(isAllowedCdnUrl("https://video.fbcdn.net/a.mp4")).toBe(true);
    expect(isAllowedCdnUrl("http://scontent.cdninstagram.com/a.jpg")).toBe(false);
    expect(isAllowedCdnUrl("https://evil.com/cdninstagram.com.jpg")).toBe(false);
  });
});

describe("Range HTTP", () => {
  it("soporta rangos cerrados, abiertos y sufijos", () => {
    expect(parseRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
    expect(parseRange("bytes=6-", 10)).toEqual({ start: 6, end: 9 });
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange("bytes=0-999", 10)).toEqual({ start: 0, end: 9 });
  });

  it("rechaza rangos no satisfacibles o inválidos", () => {
    expect(parseRange("bytes=20-", 10)).toBeNull();
    expect(parseRange("bytes=6-2", 10)).toBeNull();
    expect(parseRange("bytes=-0", 10)).toBeNull();
    expect(parseRange("items=1-2", 10)).toBeNull();
    expect(parseRange("bytes=a-b", 10)).toBeNull();
  });
});

describe("clasificación de respuestas", () => {
  const ok = (body: unknown, status = 200) => ({ status, url: "https://www.instagram.com/api/v1/x", contentType: "application/json", body: JSON.stringify(body) });

  it("devuelve JSON válido", () => {
    expect(classifyJson(ok({ data: { user: { username: "a" } } }), "public")).toMatchObject({ data: { user: { username: "a" } } });
  });

  it("un muro de login en modo público ofrece usar la cuenta", () => {
    const error = (() => {
      try {
        classifyJson({ status: 200, url: "https://www.instagram.com/accounts/login/", contentType: "text/html", body: "<html>" }, "public");
      } catch (e) {
        return e as VaultError;
      }
    })();
    expect(error?.code).toBe("public_blocked");
    expect(error?.canUseAccount).toBe(true);
  });

  it("detiene en 429, checkpoint y cuenta no seguida", () => {
    expect(() => classifyJson(ok({}, 429), "account")).toThrowError(/limitó/);
    expect(() => classifyJson(ok({ message: "checkpoint_required" }, 400), "account")).toThrow(VaultError);
    try {
      classifyJson(ok({ message: "Not authorized to view user", status: "fail" }, 400), "account");
    } catch (e) {
      expect((e as VaultError).code).toBe("private_not_followed");
    }
  });

  it("acepta JSON con prefijo y varias líneas", () => {
    expect(parseJsonLoose('for (;;);{"a":1}')).toEqual([{ a: 1 }]);
    expect(parseJsonLoose('{"a":1}\n{"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
