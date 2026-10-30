# Public loopback TLS fixture

`cert.pem` and `key.pem` are a self-signed, public test pair for localhost and
127.0.0.1. The private key is deliberately public: it protects no account or
service and must never be used outside a disposable loopback fixture.

The subprocess exit test trusts this certificate explicitly through
`NODE_EXTRA_CA_CERTS`; it does not disable TLS verification. These files are
not included in the published CLI package.
