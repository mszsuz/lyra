---
created: 2026-03-07T16:09:22 (UTC +07:00)
tags: [centrifugo,real-time messaging,websocket server,pub/sub,push notifications,server-sent events,real-time API,scalable messaging,self-hosted,open source,AI streaming,LLM response streaming,stream GPT responses,real-time AI chat,AI websocket]
source: https://centrifugal.dev/docs/server/proxy
author: What if connection is unauthenticated/unauthorized to connect?
---

# Proxy events to the backend | Centrifugo

> ## Excerpt
> Proxy client events from Centrifugo to your backend. Supports connect, subscribe, publish, RPC, and refresh webhooks over HTTP and GRPC protocols.

---
Due to its self-hosted nature, Centrifugo can offer an efficient way to proxy client connection events to your application backend, enabling the backend to respond to client connection requests in a customized manner. In other words, this mechanism allows Centrifugo to send (web)hooks to the backend to control the behavior of real-time connections.

For example, you can authenticate connections by responding to requests from Centrifugo to your application backend, subscribe connections to a stable set of channels, refresh client sessions, and handle RPC calls sent by a client over a bidirectional real-time connection. Additionally, you can control subscription and publication permissions using these event proxy hooks.

## Supported proxy events[](https://centrifugal.dev/docs/server/proxy#supported-proxy-events "Direct link to Supported proxy events")

Here is the full list of events which can be proxied (we will show the details about how to configure each of those later in this chapter).

Client-wide proxy events:

-   `connect` – called when a client connects to Centrifugo, so it's possible to authenticate user, return custom initial data to a client, subscribe connection to server-side channels, attach meta information to the connection, and so on. This proxy hook available for both bidirectional and unidirectional transports.
-   `refresh` - called when a client session is going to expire, so it's possible to prolong it or just let it expire. Can also be used as a periodical connection liveness callback from Centrifugo to the app backend. Works for bidirectional and unidirectional transports.

Channel-wide proxy events:

-   `subscribe` - called when clients try to subscribe on a channel, so it's possible to check permissions and return custom initial subscription data. Works for bidirectional transports only.
-   `publish` - called when a client tries to publish into a channel, so it's possible to check permissions and optionally modify publication data. Works for bidirectional transports only.
-   `sub_refresh` - called when a client subscription is going to expire, so it's possible to prolong it or just let it expire. Can also be used just as a periodical subscription liveness callback from Centrifugo to app backend. Works for bidirectional and unidirectional transports.
-   `subscribe_stream` – this is an experimental proxy for simple integration of Centrifugo with third-party streams. It works only for bidirectional transports, and it's a bit special, so we describe this proxy type in a dedicated chapter [Proxy subscription streams](https://centrifugal.dev/docs/server/proxy_streams).
-   `cache_empty` – a hook available in Centrifugo PRO to be notified about data missing in channels with cache recovery mode. See a [dedicated description](https://centrifugal.dev/docs/pro/channel_cache_empty).
-   `state` – a hook available in Centrifugo PRO to be notified about channel `occupied` or `vacated` states. See a [dedicated description](https://centrifugal.dev/docs/pro/channel_state_events).

Finally, Centrifugo can proxy client RPC calls to the backend:

-   `rpc` - called when a client sends RPC, you can do whatever logic you need based on a client-provided RPC `method` and `data`. Works for bidirectional transports only (and bidirectional emulation), since data is sent from client to the server in this case.

## Supported proxy protocols[](https://centrifugal.dev/docs/server/proxy#supported-proxy-protocols "Direct link to Supported proxy protocols")

Before we dive into specifics of event configuration let's talk about protocols which Centrifugo can use to proxy events to the backend. Currently Centrifugo supports:

-   HTTP requests – using JSON-based communication with the backend
-   [GRPC](https://grpc.io/) – by exchanging messages based on the Protobuf schema

Both HTTP and GRPC share [the same Protobuf schema](https://github.com/centrifugal/centrifugo/blob/master/internal/proxyproto/proxy.proto) under the hood for request/response format – so you can easily extrapolate all the request/response fields described in this doc from one protocol to another.

### HTTP proxy[](https://centrifugal.dev/docs/server/proxy#http-proxy "Direct link to HTTP proxy")

HTTP proxy in Centrifugo converts client connection events into HTTP requests to the application backend. To use HTTP protocol when configuring event proxies use `http://` or `https://` in the proxy `endpoint`.

All HTTP proxy requests from Centrifugo use HTTP POST method. These requests may have some headers copied from the original client connection request (see details below) and include JSON body which varies depending on the proxy event type (see more details about different request bodies below). In response Centrifugo expects JSON from the backend with some predefined format (also see the details below).

For example, for connect event proxy the configuration which uses HTTP protocol may look like this:

config.json

```json
{  "client": {    "proxy": {      "connect": {        "enabled": true,        "endpoint": "https://your_backend/centrifugo/connect"      }    }  }}
```

Note `https` endpoint is used which gives the hint to Centrifugo to use HTTP protocol.

### GRPC proxy[](https://centrifugal.dev/docs/server/proxy#grpc-proxy "Direct link to GRPC proxy")

Another transport Centrifugo can use to proxy connection events to the app backend is GRPC. In this case, Centrifugo acts as a GRPC client and your backend acts as a GRPC server. To use GRPC protocol in proxy configuration use `grpc://` prefix when configuring the `endpoint`.

GRPC service definitions can be found in the Centrifugo repository, see [proxy.proto](https://github.com/centrifugal/centrifugo/blob/master/internal/proxyproto/proxy.proto). You can use the schema to generate GRPC server code in your programming language and write proxy handlers on top of it.

tip

We also publish Centrifugo GRPC proxy Protobuf definitions to [Buf Schema Registry](https://buf.build/centrifugo/proxyproto/docs/main:centrifugal.centrifugo.proxy). This means that it's possible to depend on pre-generated Protobuf definitions for your programming language instead of manually generating them from the schema file (see [SDKs supported by Buf registry here](https://buf.build/centrifugo/proxyproto/sdks)).

Every proxy call in this case is an unary GRPC call (except `subscribe_stream` case which is [a bit special](https://centrifugal.dev/docs/server/proxy_streams) and represented by unidirectional or bidirectional GRPC stream). Note also that Centrifugo transforms real-time connection client HTTP request headers into GRPC metadata in this case (since GRPC doesn't have headers concept).

Let's look on example how client connect proxy may be configured to use GRPC:

config.json

```json
{  "client": {    "proxy": {      "connect": {        "enabled": true,        "endpoint": "grpc://your_backend:9000"      }    }  }}
```

Basically, the main difference from HTTP proxy protocol example is an `endpoint`.

#### GRPC proxy example[](https://centrifugal.dev/docs/server/proxy#grpc-proxy-example "Direct link to GRPC proxy example")

We have [an example of backend server](https://github.com/centrifugal/examples/tree/master/v3/go_proxy/grpc) (written in Go language) which can react to events from Centrifugo over GRPC. For other programming languages the approach is similar, i.e.:

1.  Copy proxy Protobuf definitions
2.  Generate GRPC code
3.  Run backend service with you custom business logic
4.  Point Centrifugo to it.

## Proxy configuration object[](https://centrifugal.dev/docs/server/proxy#proxy-configuration-object "Direct link to Proxy configuration object")

Centrifugo re-uses the same configuration object for all proxy types. This object allows configuring the `endpoint` to use, `timeout` to apply, and various options how exactly to proxy the request to the backend, including possibility to configure protocol specific options (i.e. options specific to HTTP or GRPC requests to the backend):

|      Field name       |  Field type   | Required |                                                                      Description                                                                       |
|-----------------------|---------------|----------|--------------------------------------------------------------------------------------------------------------------------------------------------------|
|       `endpoint`        |    `string`     |   yes    | HTTP or GRPC endpoint in the same format as in default proxy mode. For example, `http://localhost:3000/path` for HTTP or `grpc://localhost:3000` for GRPC. |
|        `timeout`        |   `duration`    |    no    |                                                          Proxy request timeout, default `"1s"`                                                           |
|     `http_headers`      | `array[string]` |    no    |            List of headers from incoming client connection to proxy, by default no headers will be proxied. See Proxy HTTP headers section.            |
|     `grpc_metadata`     | `array[string]` |    no    |    List of GRPC metadata keys from incomig GRPC connection to proxy, by default no metadata keys will be proxied. See Proxy GRPC metadata section.     |
| `include_connection_meta` |     `bool`      |    no    |                Include meta information (attached on connect). This is noop for connect proxy now. See Include connection meta section.                |
|         `http`          | `HTTP options`  |    no    |                                              Allows configuring outgoing HTTP protocol specific options.                                               |
|         `grpc`          | `GRPC options`  |    no    |                                              Allows configuring outgoing GRPC protocol specific options.                                               |
|    `binary_encoding`    |     `bool`      |    no    |                                                   Use base64 for payloads. See Binary encoding mode                                                    |

#### HTTP options object[](https://centrifugal.dev/docs/server/proxy#http-options-object "Direct link to HTTP options object")

This object is used to configure outgoing HTTP-specific request options.

|       Field name        |            Field type            | Required |                                                                           Description                                                                            |
|-------------------------|----------------------------------|----------|------------------------------------------------------------------------------------------------------------------------------------------------------------------|
|     `static_headers`      |        `map[string]string`         |    no    | Static set of headers to add to HTTP proxy requests. Note these headers only appended to HTTP proxy requests from Centrifugo to backend. See Static HTTP headers |
| `status_to_code_transforms` | `array[HttpStatusToCodeTransform]` |    no    |                                                                    See dedicated description                                                                     |

#### GRPC options object[](https://centrifugal.dev/docs/server/proxy#grpc-options-object "Direct link to GRPC options object")

This object is used to configure outgoing GRPC-specific options.

|    Field name     |    Field type     | Required |                             Description                             |
|-------------------|-------------------|----------|---------------------------------------------------------------------|
|        `tls`        |    `TLS` object     |    no    |                 Allows configuring GRPC client TLS                  |
|  `credentials_key`  |      `string`       |    no    |               Add custom key to per-RPC credentials.                |
| `credentials_value` |      `string`       |    no    |                 A custom value for `credentials_key`.                 |
|    `compression`    |       `bool`        |    no    | If `true` then gzip compression will be used for each GRPC proxy call |
|  `static_metadata`  | `map[string]string` |    no    |        Static set of metadata to add to GRPC proxy requests.        |

One good thing about Centrifugo proxy is that it can transparently proxy original HTTP request headers in a request to the app backend. In many cases, this allows achieving transparent authentication on the application backend side (if `Cookie` authentication is used and request come from the same backend).

It's required to provide an explicit list of HTTP headers you want to be proxied using `http_headers` field of proxy configuration object.

For example, for connect event proxy it may look like this:

config.json

```json
{  "client": {    "proxy": {      "connect": {        "enabled": true,        "endpoint": "https://your_backend/centrifugo/connect",        "http_headers": [          "Cookie",          "Origin",          "User-Agent",          "Authorization",          "X-Real-Ip",          "X-Forwarded-For",          "X-Request-Id"        ]      }    }  }}
```

note

Centrifugo forces the `Content-Type` header to be `application/json` in all HTTP proxy requests since Centrifugo sends the body in JSON format to the application backend.

Centrifugo provides a unique feature called `headers emulation` which simplifies working with WebSocket and auth when connecting from web browser and using proxy hooks.

The thing is that WebSocket browser API does not allow setting custom HTTP headers which makes implementing authentication in the WebSocket world harder. Centrifugo users can provide a custom `headers` map to the browser SDK (`centrifuge-js`) constructor, these headers are then sent in the first message to Centrifugo, and Centrifugo can translate it to the outgoing proxy request native HTTP headers (based on `http_headers` list) – abstracting away the specifics of WebSocket protocol in a secure way. This can drastically simplify the integration from the auth perspective since the backend may re-use existing code.

It's possible to configure a static set of headers to be appended to all outgoing HTTP proxy requests (note, this is under `http` section because it's HTTP protocol proxy specific, won't be added to GRPC protocol):

config.json

```css
{  "client": {    "proxy": {      "connect": {        "enabled": true,        "endpoint": "https://your_backend/centrifugo/connect",        "http_headers": [          "Cookie"        ],        "http": {          "static_headers": {            "X-Custom-Header": "custom value"          }        }      }    }  }}
```

So it is a map with string keys and string values. You may also set it over environment variable using JSON object string:

```makefile
export CENTRIFUGO_CLIENT_PROXY_CONNECT_HTTP_STATIC_HEADERS='{"X-Custom-Header": "custom value"}'
```

Static headers may be overridden by the header from the client connection request if you proxy the header with the same name inside `http_headers` option showed above.

This is only useful when using [GRPC unidirectional stream](https://centrifugal.dev/docs/transports/uni_grpc) as a client transport. In that case you may want to proxy GRPC metadata from the client request. To do this configure `grpc_metadata` field of Proxy configuration object. This is an array of string metadata keys to be proxied. By default, no metadata keys are proxied.

See below [the table of rules](https://centrifugal.dev/docs/server/proxy#header-proxy-rules) how metadata and headers proxied in transport/proxy different scenarios.

## Client-wide proxy events[](https://centrifugal.dev/docs/server/proxy#client-wide-proxy-events "Direct link to Client-wide proxy events")

Now we know what options we have for event request protocol, and let's dive into how to enable specific event proxies in Centrifugo configuration.

### Connect proxy[](https://centrifugal.dev/docs/server/proxy#connect-proxy "Direct link to Connect proxy")

The connect proxy endpoint is called when a client connects to Centrifugo without JWT token, so it's possible to authenticate user, return custom initial data to a client, subscribe connection to server-side channels, attach meta information to the connection, and so on. This proxy hook available for both bidirectional and unidirectional transports.

Above, we already gave some examples on how to enable connect proxy, let's re-iterate:

config.json

```json
{  "client": {    "proxy": {      "connect": {        "enabled": true,        "endpoint": "grpc://your_backend:9000",        "timeout": "1s",        "http_headers": [          "Cookie",          "Authorization"        ]      }    }  }}
```

danger

Make sure you properly configured [allowed\_origins](https://centrifugal.dev/docs/server/configuration#clientallowed_origins) Centrifugo option or check request origin on your backend side upon receiving connect request from Centrifugo. Otherwise, your site can be vulnerable to CSRF attacks if you are using WebSocket transport for client connections.

This means you don't need to generate JWT and pass it to a client-side and can rely on a cookie while authenticating the user. **Centrifugo should work on the same domain in this case so your site cookie could be passed to Centrifugo by browsers**. Or you need to use headers emulation. In many cases your existing session mechanism will provide user authentication details to the connect proxy handler on your backend which processes the request from Centrifugo.

![](https://centrifugal.dev/assets/images/diagram_connect_proxy-4318d8beb2c7553d9b30b2ed7fb8edac.png)

tip

You can also pass custom data from a client side using `data` field of client SDK constructor options (available in all our SDKs). This data will be included by Centrifugo into `ConnectRequest` to the backend.

tip

Every new connection attempt to Centrifugo will result in an HTTP POST request to your application backend. While with [JWT token authentication](https://centrifugal.dev/docs/server/authentication) you generate token once on application page reload. If client reconnects due to Centrifugo restart or internet connection loss can re-use the same JWT it had before. So JWT authentication instead of connect proxy can be much more effective since it reduces load on your session backend.

Let's look and the JSON payload example that will be sent to the app backend endpoint when client without token wants to establish a connection with Centrifugo and connect proxy uses HTTP protocol:

```json
{  "client":"9336a229-2400-4ebc-8c50-0a643d22e8a0",  "transport":"websocket",  "protocol": "json",  "encoding":"json"}
```

The response from the backend Centrifugo expects looks like this:

```json
{  "result": {    "user": "56"  }}
```

This response tells Centrifugo the ID user of authenticated user and the connection is then accepted by Centrifugo. See below the full list of supported fields in the connect proxy request and response objects.

Several app examples which use connect proxy can be found in our blog:

-   [With NodeJS](https://centrifugal.dev/blog/2021/10/18/integrating-with-nodejs)
-   [With Django](https://centrifugal.dev/blog/2021/11/04/integrating-with-django-building-chat-application)
-   [With Laravel](https://centrifugal.dev/blog/2021/12/14/laravel-multi-room-chat-tutorial)

Let's now move to a more formal description of connect request and response objects.

#### ConnectRequest[](https://centrifugal.dev/docs/server/proxy#connectrequest "Direct link to ConnectRequest")

This is what sent from Centrifugo to application backend in case of connect proxy request.

|   Field   |     Type      | Required |                                                                Description                                                                 |
|-----------|---------------|----------|--------------------------------------------------------------------------------------------------------------------------------------------|
|  `client`   |    `string`     |   yes    |                                   unique client ID generated by Centrifugo for each incoming connection                                    |
| `transport` |    `string`     |   yes    |                                              transport name (ex. `websocket`, `sse`, `uni_sse` etc)                                              |
| `protocol`  |    `string`     |   yes    |                                       protocol type used by the client (`json` or `protobuf` at moment)                                        |
| `encoding`  |    `string`     |   yes    |                                           protocol encoding type used (`json` or `binary` at moment)                                           |
|   `name`    |    `string`     |    no    |                        optional name of the client (this field will only be set if provided by a client on connect)                        |
|  `version`  |    `string`     |    no    |                      optional version of the client (this field will only be set if provided by a client on connect)                       |
|   `data`    |     `JSON`      |    no    |                         optional data from client (this field will only be set if provided by a client on connect)                         |
|  `b64data`  |    `string`     |    no    |                             optional data from the client in base64 format (if the binary proxy mode is used)                              |
| `channels`  | `array[string]` |    no    | list of server-side channels client want to subscribe to, the application server must check permissions and add allowed channels to result |

#### ConnectResponse[](https://centrifugal.dev/docs/server/proxy#connectresponse "Direct link to ConnectResponse")

| Field name |  Field type   | Optional |     Description     |
|------------|---------------|----------|---------------------|
|   `result`   | `ConnectResult` |   yes    | Result of operation |
|   `error`    |     `Error`     |   yes    |    Custom error     |
| `disconnect` |  `Disconnect`   |   yes    |  Custom disconnect  |

#### Error[](https://centrifugal.dev/docs/server/proxy#error "Direct link to Error")

`Error` type represents Centrifugo-level API call error and it has common structure for all server API responses:

| Field name | Field type | Optional |  Description  |
|------------|------------|----------|---------------|
|    `code`    |  `integer`   |    no    |  Error code   |
|  `message`   |   `string`   |   yes    | Error message |

#### Disconnect[](https://centrifugal.dev/docs/server/proxy#disconnect "Direct link to Disconnect")

`Disconnect` type represents custom disconnect code and reason to close connection with.

| Field name | Field type | Optional |    Description    |
|------------|------------|----------|-------------------|
|    `code`    |  `integer`   |    no    |  Disconnect code  |
|   `reason`   |   `string`   |   yes    | Disconenct reason |

#### ConnectResult[](https://centrifugal.dev/docs/server/proxy#connectresult "Direct link to ConnectResult")

This is what an application returns to Centrifugo inside `result` field in of `ConnectResponse`.

|   Field   |                Type                | Required |                                                                             Description                                                                              |
|-----------|------------------------------------|----------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------|
|   `user`    |               `string`               |   yes    |         user ID (calculated on app backend based on request cookie header for example). Return it as an empty string for accepting unauthenticated requests          |
| `expire_at` |              `integer`               |    no    |              a timestamp (Unix seconds in the future) when connection must be considered expired. If not set or set to `0` connection won't expire at all              |
|   `info`    |                `JSON`                |    no    |            a connection info JSON. This information will be included in online presence data, join/leave events and into client-side channel publications            |
|  `b64info`  |               `string`               |    no    |                         binary connection info encoded in base64 format, will be decoded to raw bytes on Centrifugo before using in messages                         |
|   `data`    |                `JSON`                |    no    |                                                   a custom data to send to the client in connect command response.                                                   |
|  `b64data`  |               `string`               |    no    | a custom data to send to the client in the connect command response for binary connections, will be decoded to raw bytes on Centrifugo side before sending to client |
| `channels`  |           `array[string]`            |    no    |                     allows providing a list of server-side channels to subscribe connection to. See more details about server-side subscriptions                     |
|   `subs`    |    `map[string]SubscribeOptions`     |    no    |       map of channels with options to subscribe connection to. Each channel may have SubscribeOptions object. See more details about server-side subscriptions       |
|   `meta`    | `JSON` object (ex. `{"key": "value"}`) |    no    |                                             a custom data to attach to connection (this **won't be exposed to client-side**)                                             |

#### SubscribeOptions[](https://centrifugal.dev/docs/server/proxy#subscribeoptions "Direct link to SubscribeOptions")

|  Field   |          Type           | Optional |                                                                                          Description                                                                                          |
|----------|-------------------------|----------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
|   `info`   |       `JSON` object       |   yes    | Additional channel-specific information about connection (**valid JSON**). This information will be included in online presence data, join/leave events and into client-side channel publications |
| `b64info`  |         `string`          |   yes    |                                                                  Custom channel info in Base64 - to pass binary channel info                                                                  |
|   `data`   |       `JSON` object       |   yes    |                                                            Custom JSON data to return in subscription context inside Connect reply                                                            |
| `b64data`  |         `string`          |   yes    |                                                                        Same as `data` but in Base64 to send binary data                                                                         |
| `override` | `SubscribeOptionOverride` |   yes    |                          Allows dynamically override some channel options defined in Centrifugo configuration on a per-connection basis (see below available fields)                          |

#### SubscribeOptionOverride[](https://centrifugal.dev/docs/server/proxy#subscribeoptionoverride "Direct link to SubscribeOptionOverride")

Allow per-connection overrides of some channel namespace options:

|        Field        |   Type    | Optional |                     Description                     |
|---------------------|-----------|----------|-----------------------------------------------------|
|      `presence`       | `BoolValue` |   yes    |      Override `presence` from namespace options       |
|     `join_leave`      | `BoolValue` |   yes    |     Override `join_leave` from namespace options      |
|   `force_recovery`    | `BoolValue` |   yes    |   Override `force_recovery` from namespace options    |
|  `force_positioning`  | `BoolValue` |   yes    |  Override `force_positioning` from namespace options  |
| `force_push_join_leave` | `BoolValue` |   yes    | Override `force_push_join_leave` from namespace options |

#### BoolValue[](https://centrifugal.dev/docs/server/proxy#boolvalue "Direct link to BoolValue")

Is an object like this:

| Field | Type | Optional |  Description  |
|-------|------|----------|---------------|
| `value` | `bool` |    no    | `true` or `false` |

#### Example[](https://centrifugal.dev/docs/server/proxy#example "Direct link to Example")

Here is the simplest example of the connect handler in Tornado Python framework (note that in a real system you need to authenticate the user on your backend side, here we just return `"56"` as user ID):

```python
class CentrifugoConnectHandler(tornado.web.RequestHandler):    def check_xsrf_cookie(self):        pass    def post(self):        self.set_header('Content-Type', 'application/json; charset="utf-8"')        data = json.dumps({            'result': {                'user': '56'            }        })        self.write(data)def main():    options.parse_command_line()    app = tornado.web.Application([      (r'/centrifugo/connect', CentrifugoConnectHandler),    ])    app.listen(3000)    tornado.ioloop.IOLoop.instance().start()if __name__ == '__main__':    main()
```

This example should help you to implement a similar HTTP handler in any language/framework you are using on the backend side.

We also have a tutorial in the blog about [Centrifugo integration with NodeJS](https://centrifugal.dev/blog/2021/10/18/integrating-with-nodejs) which uses connect proxy and native session middleware of Express.js to authenticate connections. Even if you are not using NodeJS on a backend a tutorial can help you understand the idea.

In this case return a disconnect object in a response. See [Return custom disconnect](https://centrifugal.dev/docs/server/proxy#return-custom-disconnect) section. Depending on whether you want connection to reconnect or not (usually not) you can select the appropriate disconnect code. Sth like this in response:

```css
{  "disconnect": {    "code": 4501,    "reason": "unauthorized"  }}
```

– may be sufficient enough. Choosing codes and reason is up to the developer, but follow the rules described in [Return custom disconnect](https://centrifugal.dev/docs/server/proxy#return-custom-disconnect) section.

### Refresh proxy[](https://centrifugal.dev/docs/server/proxy#refresh-proxy "Direct link to Refresh proxy")

With the following options in the configuration file:

```bash
{  "client": {    "proxy": {      ...      "refresh": {        "enabled": true,        "endpoint": "https://your_backend/centrifugo/refresh",        "timeout": "1s"      }    }  }}
```

– Centrifugo will call the configured endpoint when it's time to refresh the connection. Centrifugo itself will ask your backend about connection validity instead of refresh workflow on the client-side.

The payload example sent to app backend in refresh request (when the connection is going to expire) in HTTP protocol case:

```json
{  "client":"9336a229-2400-4ebc-8c50-0a643d22e8a0",  "transport":"websocket",  "protocol": "json",  "encoding":"json",  "user":"56"}
```

Expected successful response example:

```json
{  "result": {    "expire_at": 1565436268  }}
```

Where `expire_at` contains some Unix time in the future (until which connection will be prolonged).

#### RefreshRequest[](https://centrifugal.dev/docs/server/proxy#refreshrequest "Direct link to RefreshRequest")

|   Field   |  Type  | Optional |                                      Description                                       |
|-----------|--------|----------|----------------------------------------------------------------------------------------|
|  `client`   | `string` |    no    |         unique client ID generated by Centrifugo for each incoming connection          |
| `transport` | `string` |    no    |                  transport name (ex. `websocket`, `sockjs`, `uni_sse` etc.)                  |
| `protocol`  | `string` |    no    |               protocol type used by client (`json` or `protobuf` at moment)                |
| `encoding`  | `string` |    no    |                 protocol encoding type used (`json` or `binary` at moment)                 |
|   `user`    | `string` |    no    |              a connection user ID obtained during authentication process               |
|   `meta`    |  `JSON`  |   yes    | a connection attached meta (off by default, enable with `"include_connection_meta": true`) |

#### RefreshResponse[](https://centrifugal.dev/docs/server/proxy#refreshresponse "Direct link to RefreshResponse")

| Field name |  Field type   | Optional |         Description         |
|------------|---------------|----------|-----------------------------|
|   `result`   | `RefreshResult` |    no    | Result of refresh operation |

#### RefreshResult[](https://centrifugal.dev/docs/server/proxy#refreshresult "Direct link to RefreshResult")

|   Field   |  Type   | Optional |                                                       Description                                                        |
|-----------|---------|----------|--------------------------------------------------------------------------------------------------------------------------|
|  `expired`  |  `bool`   |   yes    |                        a flag to mark the connection as expired - the client will be disconnected                        |
| `expire_at` | `integer` |   yes    |                           a timestamp in the future when connection must be considered expired                           |
|   `info`    |  `JSON`   |   yes    |                                               update connection info JSON                                                |
|  `b64info`  | `string`  |   yes    | alternative to `info` - a binary connection info encoded in base64 format, will be decoded to raw bytes on Centrifugo side |

## Channel-wide proxy events[](https://centrifugal.dev/docs/server/proxy#channel-wide-proxy-events "Direct link to Channel-wide proxy events")

The following types of proxies are related to channels. The same client connection may issue multiple events for different channels.

### Subscribe proxy[](https://centrifugal.dev/docs/server/proxy#subscribe-proxy "Direct link to Subscribe proxy")

This proxy is called when clients try to subscribe to a channel in a namespace where subscribe proxy is enabled. This allows checking the access permissions of the client to a channel.

info

**Subscribe proxy does not proxy [subscriptions with token](https://centrifugal.dev/docs/server/channel_token_auth) and subscriptions to [user-limited](https://centrifugal.dev/docs/server/channels#user-channel-boundary-) channels at the moment**. That's because those are already providing channel access control. Subscribe proxy assumes that all the permission management happens on the backend side when processing proxy request. So if you need to get subscribe proxy requests for all channels in the system - do not use subscription tokens and user-limited channels.

Example:

config.json

```bash
{  ...  "channel": {    "proxy": {      "subscribe": {        "endpoint": "http://localhost:3000/centrifugo/subscribe"      }    }  }}
```

Note, there is no `enabled` option here. Unlike client-wide proxy types described above subscribe proxy must be enabled per channel namespace. This means that every namespace has a boolean option `subscribe_proxy_enabled` that allows enabling subscribe proxy for channels in a namespace.

So to enable subscribe proxy for channels without namespace define `subscribe_proxy_enabled`:

```bash
{  ...  "channel": {    "proxy": {      "subscribe": {        "endpoint": "http://localhost:3000/centrifugo/subscribe"      }    },    "without_namespace": {      "subscribe_proxy_enabled": true    }  }}
```

Or, for channels in the namespace `sun`:

```bash
{  ...  "channel": {    "proxy": {      "subscribe": {        "endpoint": "http://localhost:3000/centrifugo/subscribe"      }    },    "namespaces": [      {        "name": "sun",        "subscribe_proxy_enabled": true      }    ]  }}
```

The payload example sent to the app backend in subscribe proxy request in HTTP protocol case is:

```json
{  "client":"9336a229-2400-4ebc-8c50-0a643d22e8a0",  "transport":"websocket",  "protocol": "json",  "encoding":"json",  "user":"56",  "channel": "chat:index"}
```

The expected response example if a subscription is allowed:

```json
{  "result": {}}
```

See below on how to [return an error](https://centrifugal.dev/docs/server/proxy#what-if-connection-is-not-allowed-to-subscribe) in case you don't want to allow subscribing.

#### SubscribeRequest[](https://centrifugal.dev/docs/server/proxy#subscriberequest "Direct link to SubscribeRequest")

|   Field   |  Type  | Optional |                                                        Description                                                         |
|-----------|--------|----------|----------------------------------------------------------------------------------------------------------------------------|
|  `client`   | `string` |    no    |                           unique client ID generated by Centrifugo for each incoming connection                            |
| `transport` | `string` |    no    |                                          transport name (ex. `websocket` or `sockjs`)                                          |
| `protocol`  | `string` |    no    |                               protocol type used by the client (`json` or `protobuf` at moment)                                |
| `encoding`  | `string` |    no    |                                   protocol encoding type used (`json` or `binary` at moment)                                   |
|   `user`    | `string` |    no    |                                a connection user ID obtained during authentication process                                 |
|  `channel`  | `string` |    no    |                                       a string channel client wants to subscribe to                                        |
|   `meta`    |  `JSON`  |   yes    |                   a connection attached meta (off by default, enable with `"include_connection_meta": true`)                   |
|   `data`    |  `JSON`  |   yes    | custom data from client sent with subscription request (this field will only be set if provided by a client on subscribe). |
|  `b64data`  | `string` |   yes    |              optional subscription data from the client in base64 format (if the binary proxy mode is used).               |

#### SubscribeResponse[](https://centrifugal.dev/docs/server/proxy#subscriberesponse "Direct link to SubscribeResponse")

| Field name |   Field type    | Optional |     Description     |
|------------|-----------------|----------|---------------------|
|   `result`   | `SubscribeResult` |   yes    | Result of operation |
|   `error`    |      `Error`      |   yes    |    Custom error     |
| `disconnect` |   `Disconnect`    |   yes    |  Custom disconnect  |

#### SubscribeResult[](https://centrifugal.dev/docs/server/proxy#subscriberesult "Direct link to SubscribeResult")

|   Field   |      Type       | Optional |                                                                                          Description                                                                                          |
|-----------|-----------------|----------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
|   `info`    |      `JSON`       |   yes    | Additional channel-specific information about connection (**valid JSON**). This information will be included in online presence data, join/leave events and into client-side channel publications |
|  `b64info`  |     `string`      |   yes    |                      An alternative to `info` – a binary connection channel information encoded in base64 format, will be decoded to raw bytes on Centrifugo before using                       |
|   `data`    |      `JSON`       |   yes    |                                                                 Custom data to send to the client in subscribe command reply.                                                                 |
|  `b64data`  |     `string`      |   yes    |                            Custom data to send to the client in subscribe command reply, will be decoded to raw bytes on Centrifugo side before sending to client                             |
| `override`  | `Override` object |   yes    |                          Allows dynamically override some channel options defined in Centrifugo configuration on a per-connection basis (see below available fields)                          |
| `expire_at` |     `integer`     |   yes    |       a timestamp (Unix seconds in the future) when subscription must be considered expired. If not set or set to `0` subscription won't expire at all. Supported since Centrifugo v5.0.4       |

#### Override[](https://centrifugal.dev/docs/server/proxy#override "Direct link to Override")

|        Field        |   Type    | Optional |         Description          |
|---------------------|-----------|----------|------------------------------|
|      `presence`       | `BoolValue` |   yes    |      Override presence       |
|     `join_leave`      | `BoolValue` |   yes    |     Override join_leave      |
| `force_push_join_leave` | `BoolValue` |   yes    | Override force_push_join_leave |
|  `force_positioning`  | `BoolValue` |   yes    |  Override force_positioning  |
|   `force_recovery`    | `BoolValue` |   yes    |   Override force_recovery    |

#### BoolValue[](https://centrifugal.dev/docs/server/proxy#boolvalue-1 "Direct link to BoolValue")

Is an object like this:

| Field | Type | Optional |  Description  |
|-------|------|----------|---------------|
| `value` | `bool` |    no    | `true` or `false` |

#### What if connection is not allowed to subscribe?[](https://centrifugal.dev/docs/server/proxy#what-if-connection-is-not-allowed-to-subscribe "Direct link to What if connection is not allowed to subscribe?")

In this case you can return error object as a subscribe handler response. See [return custom error](https://centrifugal.dev/docs/server/proxy#return-custom-error) section.

In general, frontend applications should not try to subscribe to channels for which access is not allowed. But these situations can happen or malicious user can try to subscribe to a channel. In most scenarios returning:

```css
{  "error": {    "code": 403,    "message": "permission denied"  }}
```

– is sufficient. Error code may be not 403 actually, no real reason to force HTTP semantics here - so it's up to Centrifugo user to decide. Just keep it in range \[400, 1999\] as described [here](https://centrifugal.dev/docs/server/proxy#return-custom-error).

If case of returning response above, on client side `unsubscribed` event of Subscription object will be called with error code 403. Subscription won't resubscribe automatically after that.

### Publish proxy[](https://centrifugal.dev/docs/server/proxy#publish-proxy "Direct link to Publish proxy")

Publish proxy endpoint is called when clients try to publish data to a channel in a namespace where publish proxy is enabled. This allows checking the access permissions of the client to publish data to a channel. And even modify data to be published.

This request happens BEFORE a message is published to a channel, so your backend can validate whether a client can publish data to a channel. An important thing here is that publication to the channel can fail after your backend successfully validated publish request (for example publish to Redis by Centrifugo returned an error). In this case, your backend won't know about the error that happened but this error will propagate to the client-side.

![](https://centrifugal.dev/assets/images/diagram_publish_proxy-66ccb1e8b37ed8912d218b4529597bd9.png)

Example:

config.json

```bash
{  ...  "channel": {    "proxy": {      "publish": {        "endpoint": "http://localhost:3000/centrifugo/publish"      }    }  }}
```

Note, there is no `enabled` option here – same as for subscribe proxy described above. Every namespace has a boolean option `publish_proxy_enabled` that allows enabling publish proxy for channels in a namespace.

So to enable publish proxy for channels without namespace define `publish_proxy_enabled`:

config.json

```bash
{  ...  "channel": {    "proxy": {      "publish": {        "endpoint": "http://localhost:3000/centrifugo/publish"      }    },    "without_namespace": {      "publish_proxy_enabled": true    }  }}
```

Or, for channels in the namespace `sun`:

config.json

```bash
{  ...  "channel": {    "proxy": {      "publish": {        "endpoint": "http://localhost:3000/centrifugo/publish"      }    },    "namespaces": [      {        "name": "sun",        "publish_proxy_enabled": true      }    ]  }}
```

The payload example sent to the app backend in publish proxy request in HTTP protocol case is:

```css
{  "client":"9336a229-2400-4ebc-8c50-0a643d22e8a0",  "transport":"websocket",  "protocol": "json",  "encoding":"json",  "user":"56",  "channel": "chat:index",  "data":{    "input":"hello"  }}
```

The expected response example if a publication is allowed:

```json
{  "result": {}}
```

#### PublishRequest[](https://centrifugal.dev/docs/server/proxy#publishrequest "Direct link to PublishRequest")

|   Field   |  Type  | Optional |                                      Description                                       |
|-----------|--------|----------|----------------------------------------------------------------------------------------|
|  `client`   | `string` |    no    |         unique client ID generated by Centrifugo for each incoming connection          |
| `transport` | `string` |    no    |                         transport name (ex. `websocket`, `sockjs`)                         |
| `protocol`  | `string` |    no    |             protocol type used by the client (`json` or `protobuf` at moment)              |
| `encoding`  | `string` |    no    |                 protocol encoding type used (`json` or `binary` at moment)                 |
|   `user`    | `string` |    no    |              a connection user ID obtained during authentication process               |
|  `channel`  | `string` |    no    |                      a string channel client wants to publish to                       |
|   `data`    |  `JSON`  |   yes    |                                  data sent by client                                   |
|  `b64data`  | `string` |   yes    |                will be set instead of `data` field for binary proxy mode                 |
|   `meta`    |  `JSON`  |   yes    | a connection attached meta (off by default, enable with `"include_connection_meta": true`) |

#### PublishResponse[](https://centrifugal.dev/docs/server/proxy#publishresponse "Direct link to PublishResponse")

| Field name |  Field type   | Optional |     Description     |
|------------|---------------|----------|---------------------|
|   `result`   | `PublishResult` |   yes    | Result of operation |
|   `error`    |     `Error`     |   yes    |    Custom error     |
| `disconnect` |  `Disconnect`   |   yes    |  Custom disconnect  |

#### PublishResult[](https://centrifugal.dev/docs/server/proxy#publishresult "Direct link to PublishResult")

|    Field     |  Type  | Optional |                                                                     Description                                                                      |
|--------------|--------|----------|------------------------------------------------------------------------------------------------------------------------------------------------------|
|     `data`     |  `JSON`  |   yes    |                                an optional JSON data to send into a channel **instead of** original data sent by a client                                |
|   `b64data`    | `string` |   yes    | a binary data encoded in base64 format, the meaning is the same as for data above, will be decoded to raw bytes on Centrifugo side before publishing |
| `skip_history` |  `bool`  |   yes    |                                      when set to `true` Centrifugo won't save publication to the channel history                                       |

See below on how to [return an error](https://centrifugal.dev/docs/server/proxy#return-custom-error) in case you don't want to allow publishing.

### Sub refresh proxy[](https://centrifugal.dev/docs/server/proxy#sub-refresh-proxy "Direct link to Sub refresh proxy")

This allows configuring the endpoint to be called when it's time to refresh the subscription. Centrifugo itself will ask your backend about subscription validity instead of subscription refresh workflow on the client-side.

Sub refresh proxy may be used as a periodical Subscription liveness callback from Centrifugo to app backend.

caution

In the current implementation the delay of Subscription refresh requests from Centrifugo to application backend may be up to one minute (was implemented this way from a simplicity and efficiency perspective). We assume this should be enough for many scenarios. But this may be improved if needed. Please reach us out with a detailed description of your use case where you want more accurate requests to refresh subscriptions.

Example:

config.json

```bash
{  ...  "channel": {    "proxy": {      "sub_refresh": {        "endpoint": "http://localhost:3000/centrifugo/sub_refresh"      }    }  }}
```

Like subscribe and publish proxy types, sub refresh proxy must be enabled per channel namespace. This means that every namespace has a boolean option `sub_refresh_proxy_enabled` that enables sub refresh proxy for channels in the namespace. Only subscriptions which have expiration time will be validated over sub refresh proxy endpoint.

So to enable sub refresh proxy for channels without namespace define `sub_refresh_proxy_enabled`:

config.json

```bash
{  ...  "channel": {    "proxy": {      "sub_refresh": {        "endpoint": "http://localhost:3000/centrifugo/sub_refresh"      }    },    "without_namespace": {      "sub_refresh_proxy_enabled": true    }  }}
```

Or, for channels in the namespace `sun`:

config.json

```bash
{  ...  "channel": {    "proxy": {      "sub_refresh": {        "endpoint": "http://localhost:3000/centrifugo/sub_refresh"      }    },    "namespaces": [      {        "name": "sun",        "sub_refresh_proxy_enabled": true      }    ]  }}
```

The payload sent to app backend in sub refresh request (when the subscription is going to expire):

```json
{  "client":"9336a229-2400-4ebc-8c50-0a643d22e8a0",  "transport":"websocket",  "protocol": "json",  "encoding":"json",  "user":"56",  "channel": "channel"}
```

Expected response example:

```json
{  "result": {    "expire_at": 1565436268  }}
```

Very similar to connection-wide refresh response.

#### SubRefreshRequest[](https://centrifugal.dev/docs/server/proxy#subrefreshrequest "Direct link to SubRefreshRequest")

|   Field   |  Type  | Optional |                                      Description                                       |
|-----------|--------|----------|----------------------------------------------------------------------------------------|
|  `client`   | `string` |    no    |         unique client ID generated by Centrifugo for each incoming connection          |
| `transport` | `string` |    no    |                  transport name (ex. `websocket`, `sockjs`, `uni_sse` etc.)                  |
| `protocol`  | `string` |    no    |               protocol type used by client (`json` or `protobuf` at moment)                |
| `encoding`  | `string` |    no    |                 protocol encoding type used (`json` or `binary` at moment)                 |
|   `user`    | `string` |    no    |              a connection user ID obtained during authentication process               |
|  `channel`  | `string` |    no    |                   channel for which Subscription is going to expire                    |
|   `meta`    |  `JSON`  |   yes    | a connection attached meta (off by default, enable with `"include_connection_meta": true`) |

#### SubRefreshResponse[](https://centrifugal.dev/docs/server/proxy#subrefreshresponse "Direct link to SubRefreshResponse")

| Field name |    Field type    | Optional |           Description           |
|------------|------------------|----------|---------------------------------|
|   `result`   | `SubRefreshResult` |    no    | Result of sub refresh operation |

#### SubRefreshResult[](https://centrifugal.dev/docs/server/proxy#subrefreshresult "Direct link to SubRefreshResult")

|   Field   |  Type   | Optional |                                                    Description                                                    |
|-----------|---------|----------|-------------------------------------------------------------------------------------------------------------------|
|  `expired`  |  `bool`   |   yes    |                   a flag to mark the subscription as expired - the client will be disconnected                    |
| `expire_at` | `integer` |   yes    |               a timestamp in the future (Unix seconds) when subscription must be considered expired               |
|   `info`    |  `JSON`   |   yes    |                               update channel-specific information about connection                                |
|  `b64info`  | `string`  |   yes    | binary channel info encoded in base64 format, will be decoded to raw bytes on Centrifugo before using in messages |

### Subscribe stream proxy[](https://centrifugal.dev/docs/server/proxy#subscribe-stream-proxy "Direct link to Subscribe stream proxy")

An experimental proxy for simple integration of Centrifugo with third-party streams. It works only for bidirectional transports, and it's a bit special, so we describe this proxy type in a dedicated chapter [Proxy subscription streams](https://centrifugal.dev/docs/server/proxy_streams).

### Cache empty proxy[](https://centrifugal.dev/docs/server/proxy#cache-empty-proxy "Direct link to Cache empty proxy")

A hook available in Centrifugo PRO to be notified about data missing in channels with cache recovery mode. See a [dedicated description](https://centrifugal.dev/docs/pro/channel_cache_empty).

### State proxy[](https://centrifugal.dev/docs/server/proxy#state-proxy "Direct link to State proxy")

A hook available in Centrifugo PRO to be notified about channel `occupied` or `vacated` states. See a [dedicated description](https://centrifugal.dev/docs/pro/channel_state_events).

## Client RPC proxy[](https://centrifugal.dev/docs/server/proxy#client-rpc-proxy "Direct link to Client RPC proxy")

Centrifugal bidirectional SDKs provide a way to issue `rpc` calls with custom `method` and `data` fields. This call is sent over WebSocket to Centrifugo and may be proxied to the app backend. Let's describe how to configure such a proxy.

This allows a developer to utilize WebSocket connection (or any other bidirectional transport Centrifugo supports) in a bidirectional way.

Example of configuration:

```bash
{  ...  "rpc": {    "proxy": {      "endpoint": "http://localhost:3000/centrifugo/rpc"    },    "without_namespace": {      "proxy_enabled": true    },    "namespaces": [      {        "name": "sun",        "proxy_enabled": true      }    ]  }}
```

The mechanics of RPC namespaces is the same as for channel namespaces. RPC requests with RPC method like `ns1:test` will use rpc proxy `rpc1`, RPC requests with RPC method like `ns2:test` will use rpc proxy `rpc2`. So Centrifugo uses `:` as RPC namespace boundary in RPC method (just like it does for channel namespaces, it's possible to configure this boundary).

Just like channel namespaces RPC namespaces should have a name which match `^[-a-zA-Z0-9_.]{2,}$` regexp pattern – this is validated on Centrifugo start.

Payload example sent to the app backend in RPC request in HTTP protocol case:

```json
{  "client":"9336a229-2400-4ebc-8c50-0a643d22e8a0",  "transport":"websocket",  "protocol": "json",  "encoding":"json",  "user":"56",  "method": "getCurrentPrice",  "data":{    "params": {"object_id": 12}  }}
```

Expected response example:

```json
{  "result": {    "data": {"answer": "2019"}  }}
```

See below on how to [return a custom error](https://centrifugal.dev/docs/server/proxy#return-custom-error).

#### RPCRequest[](https://centrifugal.dev/docs/server/proxy#rpcrequest "Direct link to RPCRequest")

|   Field   |  Type  | Optional |                                         Description                                         |
|-----------|--------|----------|---------------------------------------------------------------------------------------------|
|  `client`   | `string` |    no    |            unique client ID generated by Centrifugo for each incoming connection            |
| `transport` | `string` |    no    |                          transport name (ex. `websocket` or `sockjs`)                           |
| `protocol`  | `string` |    no    |                protocol type used by the client (`json` or `protobuf` at moment)                |
| `encoding`  | `string` |    no    |                   protocol encoding type used (`json` or `binary` at moment)                    |
|   `user`    | `string` |    no    |                 a connection user ID obtained during authentication process                 |
|  `method`   | `string` |   yes    | an RPC method string, if the client does not use named RPC call then method will be omitted |
|   `data`    |  `JSON`  |   yes    |                               RPC custom data sent by client                                |
|  `b64data`  | `string` |   yes    |                   will be set instead of `data` field for binary proxy mode                   |
|   `meta`    |  `JSON`  |   yes    |   a connection attached meta (off by default, enable with `"include_connection_meta": true`)    |

#### RPCResponse[](https://centrifugal.dev/docs/server/proxy#rpcresponse "Direct link to RPCResponse")

| Field name | Field type | Optional |     Description     |
|------------|------------|----------|---------------------|
|   `result`   | `RPCResult`  |   yes    | Result of operation |
|   `error`    |   `Error`    |   yes    |    Custom error     |
| `disconnect` | `Disconnect` |   yes    |  Custom disconnect  |

#### RPCResult[](https://centrifugal.dev/docs/server/proxy#rpcresult "Direct link to RPCResult")

|  Field  |  Type  | Optional |                               Description                               |
|---------|--------|----------|-------------------------------------------------------------------------|
|  `data`   |  `JSON`  |   yes    |               RPC response - any valid JSON is supported                |
| `b64data` | `string` |   yes    | can be set instead of `data` for binary response encoded in base64 format |

## Return custom error[](https://centrifugal.dev/docs/server/proxy#return-custom-error "Direct link to Return custom error")

Application backend can return JSON object that contains an error to return it to the client:

```css
{  "error": {    "code": 1000,    "message": "custom error"  }}
```

Applications **must use error codes in range \[400, 1999\]**. Error code field is `uint32` internally.

note

Returning custom error does not apply to response for refresh and sub refresh proxy requests as there is no sense in returning an error (will not reach client anyway). I.e. custom error is only processed for connect, subscribe, publish and rpc proxy types.

## Return custom disconnect[](https://centrifugal.dev/docs/server/proxy#return-custom-disconnect "Direct link to Return custom disconnect")

Application backend can return JSON object that contains a custom disconnect object to disconnect client in a custom way:

```css
{  "disconnect": {    "code": 4500,    "reason": "disconnect reason"  }}
```

Application **must use numbers in the range 4000-4999 for custom disconnect codes**:

-   codes in range \[4000, 4499\] give client an advice to reconnect
-   codes in range \[4500, 4999\] are terminal codes – client won't reconnect upon receiving it.

Code is `uint32` internally. Numbers outside of 4000-4999 range are reserved by Centrifugo internal protocol. Keep in mind that **due to WebSocket protocol limitations and Centrifugo internal protocol needs you need to keep disconnect reason string no longer than 32 ASCII symbols (i.e. 32 bytes max)**.

note

Returning custom disconnect does not apply to response for refresh and sub refresh proxy requests as there is no way to control disconnect at moment - the client will always be disconnected with `expired` disconnect reason. I.e. custom disconnect is only processed for connect, subscribe, publish and rpc proxy types.

## Per-namespace custom proxies[](https://centrifugal.dev/docs/server/proxy#per-namespace-custom-proxies "Direct link to Per-namespace custom proxies")

By default, with proxy configuration shown above, you can only define one proxy object for each type of event. This may be sufficient for many use cases, but in some cases for channel-wide and client rpc you need a more granular control. For example, when using microservice architecture you may want to use different subscribe proxy endpoints for different channel namespaces.

It's possible to define a list of named proxies in Centrifugo configuration and reference to them from channel or RPC namespaces.

### Defining a list of proxies[](https://centrifugal.dev/docs/server/proxy#defining-a-list-of-proxies "Direct link to Defining a list of proxies")

On configuration top level you can define `"proxies"` – an array with different named proxy objects. Each proxy object in the array must additionally have the `name` field. This `name` must be unique and match `^[-a-zA-Z0-9_.]{2,}$` regexp pattern.

Here is an example:

config.json

```bash
{  ...  "proxies": [    {      "name": "subscribe1",      "endpoint": "http://localhost:3001/centrifugo/subscribe"    },    {      "name": "publish1",      "endpoint": "http://localhost:3001/centrifugo/publish"    },    {      "name": "subscribe2",      "endpoint": "http://localhost:3002/centrifugo/subscribe"    },    {      "name": "publish2",      "endpoint": "grpc://localhost:3002"    },    {      "name": "rpc1",      "endpoint": "http://localhost:3001/centrifugo/rpc"    },    {      "name": "rpc2",      "endpoint": "grpc://localhost:3002"    }  ]}
```

These proxy objects may be then referenced by `name` from channel and RPC namespaces to be used instead of default proxy configuration shown above. Outside the `name` rest of fields in the array proxy object are the same as for general [proxy configuration object](https://centrifugal.dev/docs/server/proxy#proxy-configuration-object).

### Per-namespace channel-wide proxies[](https://centrifugal.dev/docs/server/proxy#per-namespace-channel-wide-proxies "Direct link to Per-namespace channel-wide proxies")

It's possible to use named proxy for `subscribe`, `publish`, `sub_refresh`, `subscribe_stream` channel-wide proxy events.

To reference a named proxy use `subscribe_proxy_name`, `publish_proxy_name`, `sub_refresh_proxy_name`, `subscribe_stream_proxy_name` channel namespace options.

config.json

```bash
{  ...  "proxies": [    {      "name": "subscribe1",      "endpoint": "http://localhost:3001/centrifugo/subscribe"    },    {      "name": "publish1",      "endpoint": "http://localhost:3001/centrifugo/publish"    },    {      "name": "subscribe2",      "endpoint": "http://localhost:3002/centrifugo/subscribe"    },    {      "name": "publish2",      "endpoint": "grpc://localhost:3002"    }  ],  "channel": {    "namespaces": [      {        "name": "ns1",        "subscribe_proxy_enabled": true,        "subscribe_proxy_name": "subscribe1",        "publish_proxy_enabled": true,        "publish_proxy_name": "publish1"      },      {        "name": "ns2",        "subscribe_proxy_enabled": true,        "subscribe_proxy_name": "subscribe2",        "publish_proxy_enabled": true,        "publish_proxy_name": "publish2"      }    ]  }}
```

### Per-namespace RPC proxies[](https://centrifugal.dev/docs/server/proxy#per-namespace-rpc-proxies "Direct link to Per-namespace RPC proxies")

Analogous to channel namespaces it's possible to configure different proxies in different rpc namespaces:

config.json

```bash
{  ...  "proxies": [    ...    {      "name": "rpc1",      "endpoint": "http://localhost:3001/centrifugo/rpc"    },    {      "name": "rpc2",      "endpoint": "grpc://localhost:3002"    }  ],  "rpc": {    "namespaces": [      {        "name": "ns1",        "proxy_enabled": true,        "proxy_name": "rpc1"      },      {        "name": "ns2",        "proxy_enabled": true,        "proxy_name": "rpc2"      }    ]  }}
```

Centrifugo not only supports HTTP-based client transports but also GRPC-based (for example GRPC unidirectional stream). Here is a table with rules used to proxy headers/metadata in various scenarios:

| Client protocol type | Proxy type |      Client headers       |      Client metadata      |
|----------------------|------------|---------------------------|---------------------------|
|         HTTP         |    HTTP    | In proxy request headers  |            N/A            |
|         GRPC         |    GRPC    |            N/A            | In proxy request metadata |
|         HTTP         |    GRPC    | In proxy request metadata |            N/A            |
|         GRPC         |    HTTP    |            N/A            | In proxy request headers  |

## Binary encoding mode[](https://centrifugal.dev/docs/server/proxy#binary-encoding-mode "Direct link to Binary encoding mode")

As you may have noticed there are several fields in request/result description of various proxy calls which use `base64` encoding.

Centrifugo can work with binary Protobuf protocol (in case of bidirectional WebSocket transport). All our bidirectional clients support this.

Most Centrifugo users use JSON for custom payloads: i.e. for data sent to a channel, for connection info attached while authenticating (which becomes part of presence response, join/leave messages and added to Publication client info when message published from a client side).

But since HTTP proxy works with JSON format (i.e. sends requests with JSON body) – it can not properly pass binary data to the application backend. Arbitrary binary data can't be encoded into JSON.

In this case it's possible to turn Centrifugo proxy into binary mode by using `binary_encoding` option of proxy configuration.

Once enabled this option tells Centrifugo to use base64 format in requests and utilize fields like `b64data`, `b64info` with payloads encoded to base64 instead of their JSON field analogues.

While this feature is useful for HTTP proxy it's not really required if you are using GRPC proxy – since GRPC allows passing binary data just fine.

Regarding b64 fields in proxy results – just use base64 fields when required – Centrifugo is smart enough to detect that you are using base64 field and will pick payload from it, decode from base64 automatically and will pass further to connections in binary format.

It's possible to attach some meta information to connection and pass it to the application backend in proxy requests.

The `meta` field in proxy request is off by default. To enable it set `include_connection_meta` to `true` in proxy object configuration.

The `meta` data can be attached to the connection in the following ways:

-   by setting `meta` field in [connection JWT token](https://centrifugal.dev/docs/server/authentication#meta)
-   by setting `meta` field in [ConnectResult](https://centrifugal.dev/docs/server/proxy#connectresult) of connect proxy.

## Unexpected error handling and code transforms[](https://centrifugal.dev/docs/server/proxy#unexpected-error-handling-and-code-transforms "Direct link to Unexpected error handling and code transforms")

If the unexpected error happens (i.e. the one which have not been returned by your backend explicitly) during `connect` proxy request, then:

-   bidirectional client (i.e. Centrifugal client SDK) will receive `100: internal server error` error and must reconnect with the backoff.
-   unidirectional client will be disconnected with `3004 (internal server error)` disconnect code. In most cases this should result into a reconnect too – but the behaviour of unidirectional clients is controlled by application developers as no Centrifugal SDK is used in that case.

For `subscribe`, `publish`, `rpc` proxies the error reaches bidirectional client (for unidirectional client this does not apply at all as unidirectional client can't issue these operations).

For `publish` and `rpc` the error reaches app developer's code and developers can handle it in a custom way.

Errors for `subscribe` are handled by the bidirectional SDKs automatically and my result into automatic re-subscription, or terminal unsubscribe (depending on the `temporary` flag of error object). The error `100: internal server error` used by default in case of non-200 HTTP proxy request status is temporary and leads to a re-subscription.

If the error happens during `refresh` proxy call – Centrifugo automatically retries the refresh call after some time, so temporary downtime of the app backend does not corrupt established connections.

It's possible to tweak default Centrifugo behaviors and configure HTTP proxy response status code transforms.

config.json

```json
{  "client": {    "proxy": {      "connect": {        "enabled": true,        "http": {          "status_to_code_transforms": [            {"status_code": 404, "to_error": {"code": 404, "message": "not found", "temporary": false}},            {"status_code": 403, "to_error": {"code": 403, "message": "permission denied", "temporary": false}},            {"status_code": 429, "to_error": {"code": 429, "message": "too many requests", "temporary": true}}          ]        }      }    }  }}
```

As mentioned, these codes will eventually reach client and it will act according to the specific error and event type as described above.

For the unidirectional client and `connect` case a special care may be needed – caused by the fact that a unidirectional client can't receive an error reply to a connect command (it only receives Centrifugal client protocol `Push` types). That's why Centrifugo automatically transforms error codes to disconnect codes for unidirectional clients. As mentioned, by default any error from proxy level is transformed to `3004` disconnect code. If you need to use custom disconnect codes for errors you can provide Centrifugo a mapping of error codes to disconnect objects:

config.json

```css
{  "client": {    "connect_code_to_unidirectional_disconnect": {      "enabled": true,      "transforms": [        {"code": 404, "to": {"code": 4904, "reason": "not found"}},        {"code": 403, "to": {"code": 4903, "reason": "permission denied"}},        {"code": 429, "to": {"code": 4429, "reason": "too many requests"}}      ]    }  }}
```

This is then applied to all unidirectional transports.

If you are using only unidirectional transports, then it's possible to avoid configuring two different mappings to transform status codes to errors and then error codes to disconnect codes, and use the following instead:

config.json

```css
{  "client": {    "proxy": {      "connect": {        "enabled": true,        "http": {          "status_to_code_transforms": [            {"status_code": 404, "to_disconnect": {"code": 4904, "reason": "not found"}},            {"status_code": 403, "to_disconnect": {"code": 4903, "reason": "permission denied"}},            {"status_code": 429, "to_disconnect": {"code": 4429, "reason": "too many requests"}}          ]        }      }    }  }}
```

For unidirectional SSE/EventSource (`uni_sse`) and unidirectional HTTP-streaming (`uni_http_stream`) it's also possible to return HTTP status codes instead of protocol-level disconnects. For example, for `uni_sse` transport:

config.json

```css
{  "uni_sse": {    "enabled": true,    "connect_code_to_http_response": {      "enabled": true,      "transforms": [        {"code": 404, "to": {"status_code": 404}},        {"code": 403, "to": {"status_code": 403}},        {"code": 429, "to": {"status_code": 429}}      ]    }  }}
```

While in this example codes match, there could be situations when protocol level error/disconnect codes can't match directly to HTTP codes, that's why Centrifugo requires an explicit configuration.
