# Contributing

Thanks for taking an interest in `esa-contact-mailer`.

## Ways to help

- Report bugs or unclear docs via [Issues](https://github.com/Speakingplease/esa-contact-mailer/issues)
- Open a pull request for small, focused fixes
- Improve the README if a setup step tripped you up

## Development

```bash
npm install
cp .env.example .env
# fill SMTP_USER / SMTP_PASS for a real send test
npm run check
npm start
```

## Guidelines

- Keep changes small and scoped — this is intentionally a single-file mailer
- Do not commit `.env` or real credentials
- If you touch the Aliyun ESA blocks, keep the
  `BEGIN / END Aliyun ESA AI Captcha (optional)` markers so soft/hard removal stays obvious
- Prefer clarifying comments over new abstractions

## Pull requests

1. Fork and create a branch
2. Make your change
3. Run `npm run check`
4. Open a PR with a short description of *why*

By contributing, you agree that your contributions will be licensed under the MIT License.
