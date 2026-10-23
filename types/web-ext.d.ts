// web-ext ships no type declarations. The one call made through its API is cmd.sign
// (tools/sign-amo.mjs), with these options; what it resolves to is read only for
// downloadedFiles (signOrCollect).
declare module 'web-ext' {
  interface SignOptions {
    sourceDir: string;
    artifactsDir: string;
    channel: 'listed' | 'unlisted';
    apiKey: string;
    apiSecret: string;
    amoBaseUrl: string;
    approvalTimeout: number;
  }
  const webExt: {
    cmd: {
      sign(options: SignOptions): Promise<{downloadedFiles?: string[]}>;
    };
  };
  export default webExt;
}
