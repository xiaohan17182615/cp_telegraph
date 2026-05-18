declare module "qrcode-terminal" {
  const qr: {
    generate(
      input: string,
      options: { small?: boolean },
      callback: (output: string) => void,
    ): void;
  };
  export default qr;
}
