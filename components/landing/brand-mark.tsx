import Image from "next/image";

export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <Image
      src="/logo.png"
      alt=""
      width={size}
      height={size}
      className="size-7 rounded-full"
      priority
    />
  );
}
