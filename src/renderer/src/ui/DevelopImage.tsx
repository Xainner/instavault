import { useEffect, useState, type ImgHTMLAttributes } from "react";

/** Imágenes que ya se revelaron en esta sesión: no se vuelve a animar al re-montarse. */
const developed = new Set<string>();

/**
 * Imagen con efecto de revelado fotográfico: entra difuminada y en sepia y
 * “aparece” en color al cargar. Es la firma visual de InstaVault.
 */
export function DevelopImage({ src, className = "", alt = "", ...rest }: ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const known = developed.has(src);
  const [ready, setReady] = useState(known);
  useEffect(() => {
    setReady(developed.has(src));
  }, [src]);
  return (
    <img
      {...rest}
      src={src}
      alt={alt}
      draggable={false}
      decoding="async"
      loading="lazy"
      className={`develop ${className}`}
      data-developed={ready}
      data-instant={known}
      onLoad={(event) => {
        developed.add(src);
        setReady(true);
        rest.onLoad?.(event);
      }}
    />
  );
}
