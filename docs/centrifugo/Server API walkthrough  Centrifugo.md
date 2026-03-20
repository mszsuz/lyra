---
created: 2026-03-07T15:59:24 (UTC +07:00)
tags: [centrifugo,real-time messaging,websocket server,pub/sub,push notifications,server-sent events,real-time API,scalable messaging,self-hosted,open source,AI streaming,LLM response streaming,stream GPT responses,real-time AI chat,AI websocket]
source: https://centrifugal.dev/docs/server/server_api
author: HTTP API authorization
---

# Server API walkthrough | Centrifugo

> ## Excerpt
> Centrifugo server API reference for HTTP and GRPC. Publish messages, manage channels, disconnect users, query presence and history from your backend.

---
Server API provides various methods to interact with Centrifugo from your application backend. Specifically, in most cases server API this is an entrypoint for publications into channels (see [publish](https://centrifugal.dev/docs/server/server_api#publish) method). It also allows getting information about Centrifugo cluster, disconnect users, extract channel online presence information, channel history, and so on.

There are two kinds of server API available at the moment:

-   HTTP API
-   GRPC API

Both are similar in terms of request/response structures as they share the same schema under the hood.

## HTTP API[](https://centrifugal.dev/docs/server/server_api#http-api "Direct link to HTTP API")

HTTP API is the simplest way to communicate with Centrifugo from your application backend or from terminal.

Centrifugo HTTP API works on `/api` path prefix (by default). The request format is super-simple: HTTP POST request to a specific method API path with `application/json` Content-Type, `X-API-Key` header and with JSON body (specific for each API method).

Instead of many words, here is an example how to call `publish` method to send some data to Centrifugo channel so that all active channel subscribers will receive the data:

```css
curl --header "X-API-Key: <API_KEY>" \  --request POST \  --data '{"channel": "test", "data": {"value": "test_value"}}' \  http://localhost:8000/api/publish
```

Below we look at all aspects of Centrifugo HTTP API in detail, starting with information about authorization.

### `http_api.key`[](https://centrifugal.dev/docs/server/server_api#http_apikey "Direct link to http_apikey")

String. Default: `""`.

HTTP API is protected by `http_api.key` option set in Centrifugo configuration. I.e. `http_api.key` option must be added to the config, like:

config.json

```bash
{  ...  "http_api": {    "key": "<YOUR_API_KEY>"    }}
```

This API key must be then set in the request `X-API-Key` header in this way:

```css
X-API-Key: <YOUR_API_KEY>
```

It's also possible to pass API key over URL query param. Simply add `?api_key=<YOUR_API_KEY>` query param to the API endpoint. Keep in mind that passing the API key in the `X-API-Key` header is a recommended way as it is considered more secure.

### `http_api.insecure`[](https://centrifugal.dev/docs/server/server_api#http_apiinsecure "Direct link to http_apiinsecure")

INSECURE OPTION.

This option is insecure and mostly intended for development. In case of using in production – please make sure you understand the possible security risks.

Boolean. Default: `false`.

To disable API key check on Centrifugo side you can use `http_api.insecure` configuration option (boolean, default `false`). Use it in development only or make sure to protect the API endpoint by proxy or firewall rules in production – to prevent anyone with access to the endpoint to send commands over your unprotected Centrifugo API.

We also recommended protecting Centrifugo API with TLS layer.

## API methods[](https://centrifugal.dev/docs/server/server_api#api-methods "Direct link to API methods")

Server API supports many methods. Let's describe them starting with the most important `publish` operation.

### publish[](https://centrifugal.dev/docs/server/server_api#publish "Direct link to publish")

Publish method allows publishing data into a channel (we call this message `publication` in Centrifugo). Most probably this is a command you'll use most of the time.

Here is an example of publishing message to Centrifugo:

```css
curl --header "X-API-Key: <API_KEY>" \  --request POST \  --data '{"channel": "chat", "data": {"text": "hello"}}' \  http://localhost:8000/api/publish
```

In case of successful publish you will get a response like this:

```json
{    "result": {}}
```

As an additional example, let's take a look how to publish to Centrifugo with `requests` library for Python:

```kotlin
import jsonimport requestsapi_key = "YOUR_API_KEY"data = json.dumps({    "channel": "docs",     "data": {        "content": "1"    }})headers = {'Content-type': 'application/json', 'X-API-Key': api_key}resp = requests.post("https://centrifuge.example.com/api/publish", data=data, headers=headers)print(resp.json())
```

In case of publication error, response object will contain `error` field. For example, let's publish to an unknown namespace (not defined in Centrifugo configuration):

```css
curl --header "X-API-Key: <API_KEY>" \  --request POST \  --data '{"channel": "unknown:chat", "data": {"text": "hello"}}' \  http://localhost:8000/api/publish
```

In response, you will also get 200 OK, but payload will contain `error` field instead of `result`:

```css
{    "error": {        "code": 102,        "message": "namespace not found"    }}
```

`error` object contains error code and message - this is also the same for other commands described below.

#### PublishRequest[](https://centrifugal.dev/docs/server/server_api#publishrequest "Direct link to PublishRequest")

|   Field name    |    Field type     | Required |                                                                                                                                                                                                       Description                                                                                                                                                                                                        |
|-----------------|-------------------|----------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
|     `channel`     |      `string`       |   yes    |                                                                                                                                                                                                Name of channel to publish                                                                                                                                                                                                |
|      `data`       |     any `JSON`      |   yes    |                                                                                                                                                                                        Custom JSON data to publish into a channel                                                                                                                                                                                        |
|  `skip_history`   |       `bool`        |    no    |                                                                                                                                                                                   Skip adding publication to history for this request                                                                                                                                                                                    |
|      `tags`       | `map[string]string` |    no    |                                                                                                                                              Publication tags - map with arbitrary string keys and values which is attached to publication and will be delivered to clients                                                                                                                                              |
|     `b64data`     |      `string`       |    no    |                                                                                       Custom binary data to publish into a channel encoded to base64 so it's possible to use HTTP API to send binary to clients. Centrifugo will decode it from base64 before publishing. In case of GRPC you can publish binary using `data` field.                                                                                       |
| `idempotency_key` |      `string`       |    no    |                                                                                            Optional idempotency key to drop duplicate publications upon retries. It acts per channel. Centrifugo currently keeps the cache of idempotent publish results during 5 minutes window. Supported only by Memory and Redis engines                                                                                             |
|      `delta`      |      `boolean`      |    no    |                                                                                                                                                    When set to true tells Centrifugo to construct delta update if possible when broadcasting message to subscribers.                                                                                                                                                     |
|     `version`     |      `integer`      |    no    | When >0 gives Centrifugo a tip about the version of real-time document being sent, Centrifugo will check the version and ignore publications with versions less or equal than already seen. **Checking version only works in channels with history enabled** and mostly useful when publications in channel contain the entire state, so skipping intermediate publications is safe and beneficial. New in Centrifugo v6.2.0 |
|  `version_epoch`  |      `string`       |    no    |                                                                                                           When set tells Centrifugo the epoch of version. When it changes – it tells Centrifugo that version has another epoch and even if it is less than previous - Centrifugo will accept the publication.                                                                                                            |

#### PublishResponse[](https://centrifugal.dev/docs/server/server_api#publishresponse "Direct link to PublishResponse")

| Field name |  Field type   | Optional |     Description     |
|------------|---------------|----------|---------------------|
|   `error`    |     `Error`     |   yes    | Error of operation  |
|   `result`   | `PublishResult` |   yes    | Result of operation |

Always check whether `error` is set, otherwise consider publish successful and can use `result`.

#### Error[](https://centrifugal.dev/docs/server/server_api#error "Direct link to Error")

`Error` type represents Centrifugo-level API call error and it has common structure for all server API responses:

| Field name | Field type | Optional |  Description  |
|------------|------------|----------|---------------|
|    `code`    |  `integer`   |    no    |  Error code   |
|  `message`   |   `string`   |   yes    | Error message |

#### PublishResult[](https://centrifugal.dev/docs/server/server_api#publishresult "Direct link to PublishResult")

| Field name | Field type | Optional |               Description               |
|------------|------------|----------|-----------------------------------------|
|   `offset`   |  `integer`   |   yes    | Offset of publication in history stream |
|   `epoch`    |   `string`   |   yes    |         Epoch of current stream         |

### broadcast[](https://centrifugal.dev/docs/server/server_api#broadcast "Direct link to broadcast")

`broadcast` is similar to `publish` but allows to efficiently send the **same data** into **many channels**:

```css
curl --header "X-API-Key: <API_KEY>" \  --request POST \  --data '{"channels": ["user:1", "user:2"], "data": {"text": "hello"}}' \  http://localhost:8000/api/broadcast
```

This command may be very useful when implementing messenger application, like we show in [Grand Tutorial](https://centrifugal.dev/docs/tutorial/intro).

#### BroadcastRequest[](https://centrifugal.dev/docs/server/server_api#broadcastrequest "Direct link to BroadcastRequest")

|   Field name    |    Field type     | Required |                                                                                                                                                                                                       Description                                                                                                                                                                                                        |
|-----------------|-------------------|----------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
|    `channels`     |   `array[string]`   |   yes    |                                                                                                                                                                                           List of channels to publish data to                                                                                                                                                                                            |
|      `data`       |     any `JSON`      |   yes    |                                                                                                                                                                                      Custom JSON data to publish into each channel                                                                                                                                                                                       |
|  `skip_history`   |       `bool`        |    no    |                                                                                                                                                                              Skip adding publications to channels' history for this request                                                                                                                                                                              |
|      `tags`       | `map[string]string` |    no    |                                                                                                                                              Publication tags - map with arbitrary string keys and values which is attached to publication and will be delivered to clients                                                                                                                                              |
|     `b64data`     |      `string`       |    no    |                                                                                       Custom binary data to publish into a channel encoded to base64 so it's possible to use HTTP API to send binary to clients. Centrifugo will decode it from base64 before publishing. In case of GRPC you can publish binary using `data` field.                                                                                       |
| `idempotency_key` |      `string`       |    no    |                                                                                                                  Optional idempotency key to drop duplicate publications upon retries. It acts per channel. Centrifugo currently keeps the cache of idempotent publish results during 5 minutes window.                                                                                                                  |
|      `delta`      |      `boolean`      |    no    |                                                                                                                                                    When set to true tells Centrifugo to construct delta update if possible when broadcasting message to subscribers.                                                                                                                                                     |
|     `version`     |      `integer`      |    no    | When >0 gives Centrifugo a tip about the version of real-time document being sent, Centrifugo will check the version and ignore publications with versions less or equal than already seen. **Checking version only works in channels with history enabled** and mostly useful when publications in channel contain the entire state, so skipping intermediate publications is safe and beneficial. New in Centrifugo v6.2.0 |
|  `version_epoch`  |      `string`       |    no    |                                                                                                           When set tells Centrifugo the epoch of version. When it changes – it tells Centrifugo that version has another epoch and even if it is less than previous - Centrifugo will accept the publication.                                                                                                            |

#### BroadcastResponse[](https://centrifugal.dev/docs/server/server_api#broadcastresponse "Direct link to BroadcastResponse")

| Field name |   Field type    | Optional |     Description     |
|------------|-----------------|----------|---------------------|
|   `error`    |      `Error`      |   yes    | Error of operation  |
|   `result`   | `BroadcastResult` |   yes    | Result of operation |

Always check whether `error` is set, otherwise consider publish successful and can use `result`.

#### BroadcastResult[](https://centrifugal.dev/docs/server/server_api#broadcastresult "Direct link to BroadcastResult")

| Field name |       Field type       | Optional |                                  Description                                   |
|------------|------------------------|----------|--------------------------------------------------------------------------------|
| `responses`  | `array[PublishResponse]` |    no    | Responses for each individual publish (with possible error and publish result) |

### subscribe[](https://centrifugal.dev/docs/server/server_api#subscribe "Direct link to subscribe")

`subscribe` allows subscribing active user's sessions to a channel. Note, it's mostly for dynamic [server-side subscriptions](https://centrifugal.dev/docs/server/server_subs).

tip

This is not a real-time streaming subscription request – it's just a command to subscribe a specific online session to some channel.

#### Subscribe request[](https://centrifugal.dev/docs/server/server_api#subscribe-request "Direct link to Subscribe request")

|  Field name   |   Field type   | Required |                                                          Description                                                          |
|---------------|----------------|----------|-------------------------------------------------------------------------------------------------------------------------------|
|     `user`      |     `string`     |   yes    |                                                     User ID to subscribe                                                      |
|    `channel`    |     `string`     |   yes    |                                             Name of channel to subscribe user to                                              |
|     `info`      |    any `JSON`    |    no    |                     Attach custom data to subscription (will be used in presence and join/leave messages)                     |
|    `b64info`    |     `string`     |    no    |                                info in base64 for binary mode (will be decoded by Centrifugo)                                 |
|    `client`     |     `string`     |    no    | Specific client ID to subscribe (user still required to be set, will ignore other user connections with different client IDs) |
|    `session`    |     `string`     |    no    |                             Specific client session to subscribe (user still required to be set)                              |
|     `data`      |    any `JSON`    |    no    |                              Custom subscription data (will be sent to client in Subscribe push)                              |
|    `b64data`    |     `string`     |    no    |                               Same as data but in base64 format (will be decoded by Centrifugo)                               |
| `recover_since` | `StreamPosition` |    no    |                                                Stream position to recover from                                                |
|   `override`    |    `Override`    |    no    |       Allows dynamically override some channel options defined in Centrifugo configuration (see below available fields)       |

#### Override object[](https://centrifugal.dev/docs/server/server_api#override-object "Direct link to Override object")

|        Field        |   Type    | Optional |         Description          |
|---------------------|-----------|----------|------------------------------|
|      `presence`       | `BoolValue` |   yes    |      Override presence       |
|     `join_leave`      | `BoolValue` |   yes    |     Override join_leave      |
| `force_push_join_leave` | `BoolValue` |   yes    | Override force_push_join_leave |
|  `force_positioning`  | `BoolValue` |   yes    |  Override force_positioning  |
|   `force_recovery`    | `BoolValue` |   yes    |   Override force_recovery    |

#### BoolValue[](https://centrifugal.dev/docs/server/server_api#boolvalue "Direct link to BoolValue")

BoolValue is an object like this:

```bash
{  "value": true/false}
```

#### SubscribeResponse[](https://centrifugal.dev/docs/server/server_api#subscriberesponse "Direct link to SubscribeResponse")

| Field name |   Field type    | Optional |     Description     |
|------------|-----------------|----------|---------------------|
|   `error`    |      `Error`      |   yes    | Error of operation  |
|   `result`   | `SubscribeResult` |   yes    | Result of operation |

Always check whether `error` is set, otherwise consider publish successful and can use `result`.

#### SubscribeResult[](https://centrifugal.dev/docs/server/server_api#subscriberesult "Direct link to SubscribeResult")

Empty object at the moment.

### unsubscribe[](https://centrifugal.dev/docs/server/server_api#unsubscribe "Direct link to unsubscribe")

`unsubscribe` allows unsubscribing user from a channel.

#### UnsubscribeRequest[](https://centrifugal.dev/docs/server/server_api#unsubscriberequest "Direct link to UnsubscribeRequest")

| Field name | Field type | Required |                              Description                               |
|------------|------------|----------|------------------------------------------------------------------------|
|    `user`    |   `string`   |   yes    |                         User ID to unsubscribe                         |
|  `channel`   |   `string`   |   yes    |                 Name of channel to unsubscribe user to                 |
|   `client`   |   `string`   |    no    |   Specific client ID to unsubscribe (user still required to be set)    |
|  `session`   |   `string`   |    no    | Specific client session to disconnect (user still required to be set). |

#### UnsubscribeResponse[](https://centrifugal.dev/docs/server/server_api#unsubscriberesponse "Direct link to UnsubscribeResponse")

| Field name |    Field type     | Optional |     Description     |
|------------|-------------------|----------|---------------------|
|   `error`    |       `Error`       |   yes    | Error of operation  |
|   `result`   | `UnsubscribeResult` |   yes    | Result of operation |

#### UnsubscribeResult[](https://centrifugal.dev/docs/server/server_api#unsubscriberesult "Direct link to UnsubscribeResult")

Empty object at the moment.

### disconnect[](https://centrifugal.dev/docs/server/server_api#disconnect "Direct link to disconnect")

`disconnect` allows disconnecting a user by ID.

#### DisconnectRequest[](https://centrifugal.dev/docs/server/server_api#disconnectrequest "Direct link to DisconnectRequest")

| Field name |  Field type   | Required |                              Description                               |
|------------|---------------|----------|------------------------------------------------------------------------|
|    `user`    |    `string`     |   yes    |                         User ID to disconnect                          |
|   `client`   |    `string`     |    no    |    Specific client ID to disconnect (user still required to be set)    |
|  `session`   |    `string`     |    no    | Specific client session to disconnect (user still required to be set). |
| `whitelist`  | `array[string]` |    no    |                      Array of client IDs to keep                       |
| `disconnect` |  `Disconnect`   |    no    |              Provide custom disconnect object, see below               |

#### Disconnect object[](https://centrifugal.dev/docs/server/server_api#disconnect-object "Direct link to Disconnect object")

| Field name | Field type | Required |    Description    |
|------------|------------|----------|-------------------|
|    `code`    |    `int`     |   yes    |  Disconnect code  |
|   `reason`   |   `string`   |   yes    | Disconnect reason |

#### DisconnectResponse[](https://centrifugal.dev/docs/server/server_api#disconnectresponse "Direct link to DisconnectResponse")

| Field name |    Field type    | Optional |     Description     |
|------------|------------------|----------|---------------------|
|   `error`    |      `Error`       |   yes    | Error of operation  |
|   `result`   | `DisconnectResult` |   yes    | Result of operation |

#### DisconnectResult[](https://centrifugal.dev/docs/server/server_api#disconnectresult "Direct link to DisconnectResult")

Empty object at the moment.

### refresh[](https://centrifugal.dev/docs/server/server_api#refresh "Direct link to refresh")

`refresh` allows refreshing user connection (mostly useful when unidirectional transports are used).

#### RefreshRequest[](https://centrifugal.dev/docs/server/server_api#refreshrequest "Direct link to RefreshRequest")

| Field name | Field type | Required |                             Description                              |
|------------|------------|----------|----------------------------------------------------------------------|
|    `user`    |   `string`   |   yes    |                          User ID to refresh                          |
|   `client`   |   `string`   |    no    |         Client ID to refresh (user still required to be set)         |
|  `session`   |   `string`   |    no    | Specific client session to refresh (user still required to be set).  |
|  `expired`   |    `bool`    |    no    | Mark connection as expired and close with Disconnect Expired reason  |
| `expire_at`  |    `int`     |    no    | Unix time (in seconds) in the future when the connection will expire |

#### RefreshResponse[](https://centrifugal.dev/docs/server/server_api#refreshresponse "Direct link to RefreshResponse")

| Field name |  Field type   | Optional |     Description     |
|------------|---------------|----------|---------------------|
|   `error`    |     `Error`     |   yes    | Error of operation  |
|   `result`   | `RefreshResult` |   yes    | Result of operation |

#### RefreshResult[](https://centrifugal.dev/docs/server/server_api#refreshresult "Direct link to RefreshResult")

Empty object at the moment.

### presence[](https://centrifugal.dev/docs/server/server_api#presence "Direct link to presence")

`presence` allows getting channel online presence information (all clients currently subscribed on this channel).

```bash
curl --header "X-API-Key: <API_KEY>" \  --request POST \  --data '{"channel": "chat"}' \  http://localhost:8000/api/presence
```

Example response:

```json
{    "result": {        "presence": {            "c54313b2-0442-499a-a70c-051f8588020f": {                "client": "c54313b2-0442-499a-a70c-051f8588020f",                "user": "42"            },            "adad13b1-0442-499a-a70c-051f858802da": {                "client": "adad13b1-0442-499a-a70c-051f858802da",                "user": "42"            }        }    }}
```

#### PresenceRequest[](https://centrifugal.dev/docs/server/server_api#presencerequest "Direct link to PresenceRequest")

| Field name | Field type | Required |              Description              |
|------------|------------|----------|---------------------------------------|
|  `channel`   |   `string`   |   yes    | Name of channel to call presence from |

#### PresenceResponse[](https://centrifugal.dev/docs/server/server_api#presenceresponse "Direct link to PresenceResponse")

| Field name |   Field type   | Optional |     Description     |
|------------|----------------|----------|---------------------|
|   `error`    |     `Error`      |   yes    | Error of operation  |
|   `result`   | `PresenceResult` |   yes    | Result of operation |

#### PresenceResult[](https://centrifugal.dev/docs/server/server_api#presenceresult "Direct link to PresenceResult")

| Field name |      Field type       | Optional |               Description               |
|------------|-----------------------|----------|-----------------------------------------|
|  `presence`  | `map[string]ClientInfo` |    no    | Offset of publication in history stream |

#### ClientInfo[](https://centrifugal.dev/docs/server/server_api#clientinfo "Direct link to ClientInfo")

| Field name | Field type | Optional |       Description        |
|------------|------------|----------|--------------------------|
|   `client`   |   `string`   |    no    |        Client ID         |
|    `user`    |   `string`   |    no    |         User ID          |
| `conn_info`  |    `JSON`    |   yes    | Optional connection info |
| `chan_info`  |    `JSON`    |   yes    |  Optional channel info   |

### presence\_stats[](https://centrifugal.dev/docs/server/server_api#presence_stats "Direct link to presence_stats")

`presence_stats` allows getting short channel presence information - number of clients and number of unique users (based on user ID).

```bash
curl --header "X-API-Key: <API_KEY>" \  --request POST \  --data '{"channel": "chat"}' \  http://localhost:8000/api/presence_stats
```

Example response:

```json
{    "result": {        "num_clients": 0,        "num_users": 0    }}
```

#### PresenceStatsRequest[](https://centrifugal.dev/docs/server/server_api#presencestatsrequest "Direct link to PresenceStatsRequest")

| Field name | Field type | Required |              Description              |
|------------|------------|----------|---------------------------------------|
|  `channel`   |   `string`   |   yes    | Name of channel to call presence from |

#### PresenceStatsResponse[](https://centrifugal.dev/docs/server/server_api#presencestatsresponse "Direct link to PresenceStatsResponse")

| Field name |     Field type      | Optional |     Description     |
|------------|---------------------|----------|---------------------|
|   `error`    |        `Error`        |   yes    | Error of operation  |
|   `result`   | `PresenceStatsResult` |   yes    | Result of operation |

#### PresenceStatsResult[](https://centrifugal.dev/docs/server/server_api#presencestatsresult "Direct link to PresenceStatsResult")

| Field name  | Field type | Optional |               Description               |
|-------------|------------|----------|-----------------------------------------|
| `num_clients` |  `integer`   |    no    |   Total number of clients in channel    |
|  `num_users`  |  `integer`   |    no    | Total number of unique users in channel |

### history[](https://centrifugal.dev/docs/server/server_api#history "Direct link to history")

`history` allows getting channel history information (list of last messages published into the channel). By default if no `limit` parameter set in request `history` call will only return current stream position information - i.e. `offset` and `epoch` fields. To get publications you must explicitly provide `limit` parameter. See also history API description in [special doc chapter](https://centrifugal.dev/docs/server/history_and_recovery#history-iteration-api).

tip

History in channels is not enabled by default. See how to enable it over [channel options](https://centrifugal.dev/docs/server/channels#channel-options).

```css
curl --header "X-API-Key: <API_KEY>" \  --request POST \  --data '{"channel": "chat", "limit": 2}' \  http://localhost:8000/api/history
```

Example response:

```css
{    "result": {        "epoch": "qFhv",        "offset": 4,        "publications": [            {                "data": {                    "text": "hello"                },                "offset": 2            },            {                "data": {                    "text": "hello"                },                "offset": 3            }        ]    }}
```

#### HistoryRequest[](https://centrifugal.dev/docs/server/server_api#historyrequest "Direct link to HistoryRequest")

| Field name |   Field type   | Required |                                                                         Description                                                                          |
|------------|----------------|----------|--------------------------------------------------------------------------------------------------------------------------------------------------------------|
|  `channel`   |     `string`     |   yes    |                                                             Name of channel to call history from                                                             |
|   `limit`    |      `int`       |    no    | Limit number of returned publications, if not set in request then only current stream position information will present in result (without any publications) |
|   `since`    | `StreamPosition` |    no    |                                                          To return publications after this position                                                          |
|  `reverse`   |      `bool`      |    no    |                                                     Iterate in reversed order (from latest to earliest)                                                      |

#### StreamPosition[](https://centrifugal.dev/docs/server/server_api#streamposition "Direct link to StreamPosition")

| Field name | Field type | Required |    Description     |
|------------|------------|----------|--------------------|
|   `offset`   |  `integer`   |   yes    | Offset in a stream |
|   `epoch`    |   `string`   |   yes    |    Stream epoch    |

#### HistoryResponse[](https://centrifugal.dev/docs/server/server_api#historyresponse "Direct link to HistoryResponse")

| Field name |  Field type   | Optional |     Description     |
|------------|---------------|----------|---------------------|
|   `error`    |     `Error`     |   yes    | Error of operation  |
|   `result`   | `HistoryResult` |   yes    | Result of operation |

#### HistoryResult[](https://centrifugal.dev/docs/server/server_api#historyresult "Direct link to HistoryResult")

|  Field name  |     Field type     | Optional |           Description           |
|--------------|--------------------|----------|---------------------------------|
| `publications` | `array[Publication]` |   yes    | List of publications in channel |
|    `offset`    |      `integer`       |   yes    |  Top offset in history stream   |
|    `epoch`     |       `string`       |   yes    |     Epoch of current stream     |

### history\_remove[](https://centrifugal.dev/docs/server/server_api#history_remove "Direct link to history_remove")

`history_remove` allows removing publications in channel history. Current top stream position meta data kept untouched to avoid client disconnects due to insufficient state.

#### HistoryRemoveRequest[](https://centrifugal.dev/docs/server/server_api#historyremoverequest "Direct link to HistoryRemoveRequest")

| Field name | Field type | Required |            Description            |
|------------|------------|----------|-----------------------------------|
|  `channel`   |   `string`   |   yes    | Name of channel to remove history |

### HistoryRemoveResponse[](https://centrifugal.dev/docs/server/server_api#historyremoveresponse "Direct link to HistoryRemoveResponse")

| Field name |     Field type      | Optional |     Description     |
|------------|---------------------|----------|---------------------|
|   `error`    |        `Error`        |   yes    | Error of operation  |
|   `result`   | `HistoryRemoveResult` |   yes    | Result of operation |

#### HistoryRemoveResult[](https://centrifugal.dev/docs/server/server_api#historyremoveresult "Direct link to HistoryRemoveResult")

Empty object at the moment.

### channels[](https://centrifugal.dev/docs/server/server_api#channels "Direct link to channels")

`channels` return active channels (with one or more active subscribers in it).

```bash
curl --header "X-API-Key: <API_KEY>" \  --request POST \  --data '{}' \  http://localhost:8000/api/channels
```

#### ChannelsRequest[](https://centrifugal.dev/docs/server/server_api#channelsrequest "Direct link to ChannelsRequest")

| Field name | Field type | Required |                                Description                                |
|------------|------------|----------|---------------------------------------------------------------------------|
|  `pattern`   |   `string`   |    no    | Pattern to filter channels, we are using gobwas/glob library for matching |

#### ChannelsResponse[](https://centrifugal.dev/docs/server/server_api#channelsresponse "Direct link to ChannelsResponse")

| Field name |   Field type   | Optional |     Description     |
|------------|----------------|----------|---------------------|
|   `error`    |     `Error`      |   yes    | Error of operation  |
|   `result`   | `ChannelsResult` |   yes    | Result of operation |

#### ChannelsResult[](https://centrifugal.dev/docs/server/server_api#channelsresult "Direct link to ChannelsResult")

| Field name |       Field type       | Optional |                          Description                          |
|------------|------------------------|----------|---------------------------------------------------------------|
|  `channels`  | `map[string]ChannelInfo` |    no    | Map where key is channel and value is ChannelInfo (see below) |

#### ChannelInfo[](https://centrifugal.dev/docs/server/server_api#channelinfo "Direct link to ChannelInfo")

| Field name  | Field type | Optional |                          Description                          |
|-------------|------------|----------|---------------------------------------------------------------|
| `num_clients` |  `integer`   |    no    | Total number of connections currently subscribed to a channel |

caution

Keep in mind that since the `channels` method by default returns all active channels it can be really heavy for massive deployments. Centrifugo does not provide a way to paginate over channels list. At the moment we mostly suppose that `channels` API call will be used in the development process or for administrative/debug purposes, and in not very massive Centrifugo setups (with no more than 10k active channels). A better and scalable approach for huge setups could be a real-time analytics approach [described here](https://centrifugal.dev/docs/pro/analytics).

### info[](https://centrifugal.dev/docs/server/server_api#info "Direct link to info")

`info` method allows getting information about running Centrifugo nodes.

```bash
curl --header "X-API-Key: <API_KEY>" \  --request POST \  --data '{}' \  http://localhost:8000/api/info
```

Example response:

```json
{    "result": {        "nodes": [            {                "name": "Alexanders-MacBook-Pro.local_8000",                "num_channels": 0,                "num_clients": 0,                "num_users": 0,                "uid": "f844a2ed-5edf-4815-b83c-271974003db9",                "uptime": 0,                "version": ""            }        ]    }}
```

#### InfoRequest[](https://centrifugal.dev/docs/server/server_api#inforequest "Direct link to InfoRequest")

Empty object at the moment.

#### InfoResponse[](https://centrifugal.dev/docs/server/server_api#inforesponse "Direct link to InfoResponse")

| Field name | Field type | Optional |     Description     |
|------------|------------|----------|---------------------|
|   `error`    |   `Error`    |   yes    | Error of operation  |
|   `result`   | `InfoResult` |   yes    | Result of operation |

#### InfoResult[](https://centrifugal.dev/docs/server/server_api#inforesult "Direct link to InfoResult")

| Field name | Field type  | Optional |               Description                |
|------------|-------------|----------|------------------------------------------|
|   `nodes`    | `array[Node]` |    no    | Information about all nodes in a cluster |

### batch[](https://centrifugal.dev/docs/server/server_api#batch "Direct link to batch")

Batch allows sending many commands in one request. Commands processed sequentially by Centrifugo, users should check individual error in each returned reply. Useful to avoid RTT latency penalty for each command sent, this is an analogue of pipelining.

Example with two publications in one request:

```css
curl --header "X-API-Key: <API_KEY>" \  --request POST \  --data '{"commands": [{"publish": {"channel": "test1", "data": {}}}, {"publish": {"channel": "x:test2", "data": {}}}]}' \  http://localhost:8000/api/batch
```

Example response:

```css
{    "replies":[        {"publish":{}},        {"error":{"code":102,"message":"unknown channel"}}    ]}
```

It's also possible to pass `"parallel": true` on `batch` data top level to make batch commands processing parallel on Centrifugo side. This may provide reduced latency (especially in case of using Redis engine).

## HTTP API libraries[](https://centrifugal.dev/docs/server/server_api#http-api-libraries "Direct link to HTTP API libraries")

Sending an API request to Centrifugo is a simple task to do in any programming language - this is just a POST request with JSON payload in body and `Authorization` header.

But we have several official HTTP API libraries for different languages, to help developers to avoid constructing proper HTTP requests manually:

-   [cent](https://github.com/centrifugal/cent) for Python
-   [phpcent](https://github.com/centrifugal/phpcent) for PHP
-   [gocent](https://github.com/centrifugal/gocent) for Go
-   [rubycent](https://github.com/centrifugal/rubycent) for Ruby

Also, there are Centrifugo server API libraries created by community:

-   [katarinamolotova/javacent](https://github.com/katarinamolotova/javacent) – HTTP API client for Java
-   [SocketSomeone/cent.js](https://github.com/SocketSomeone/cent.js) – API client for NodeJS
-   [sajjad-fatehi/CentriAgent](https://github.com/sajjad-fatehi/centri-agent) – one more API client for NodeJS
-   [ismkdc/Centrifugo.AspNetCore](https://github.com/ismkdc/Centrifugo.AspNetCore) – API client for ASP.NET Core
-   [devops-israel/crystalcent](https://github.com/devops-israel/crystalcent) – API client for Crystal language
-   [Cyberguru1/rucent](https://github.com/Cyberguru1/rucent) – HTTP API client for Rust

tip

Also, keep in mind that Centrifugo [has GRPC API](https://centrifugal.dev/docs/server/server_api#grpc-api) so you can automatically generate client API code for your language.

## GRPC API[](https://centrifugal.dev/docs/server/server_api#grpc-api "Direct link to GRPC API")

Centrifugo also supports [GRPC](https://grpc.io/) API. With GRPC it's possible to communicate with Centrifugo using a more compact binary representation of commands and use the power of HTTP/2 which is the transport behind GRPC.

GRPC API is also useful if you want to publish binary data to Centrifugo channels.

tip

GRPC API allows calling all commands described in [HTTP API doc](https://centrifugal.dev/docs/server/server_api#http-api), actually both GRPC and HTTP API in Centrifugo based on the same Protobuf schema definition. So refer to the HTTP API description doc for the parameter and the result field description.

You can enable GRPC API in Centrifugo using `grpc_api.enabled` option:

config.json

```bash
{    ...    "grpc_api": {        "enabled": true    }}
```

By default, GRPC will be served on port `10000` but you can change it using the `grpc_api.port` option.

Now, as soon as Centrifugo started – you can send GRPC commands to it. To do this get our API Protocol Buffer definitions [from this file](https://github.com/centrifugal/centrifugo/blob/master/internal/apiproto/api.proto).

Then see [GRPC docs specific to your language](https://grpc.io/docs/) to find out how to generate client code from definitions and use generated code to communicate with Centrifugo.

### GRPC API options[](https://centrifugal.dev/docs/server/server_api#grpc-api-options "Direct link to GRPC API options")

`grpc_api` is a configuration section for gRPC server API. It's disabled by default.

#### `grpc_api.enabled`[](https://centrifugal.dev/docs/server/server_api#grpc_apienabled "Direct link to grpc_apienabled")

Type: `bool`

Env: `CENTRIFUGO_GRPC_API_ENABLED`

Enables GRPC API server.

#### `grpc_api.error_mode`[](https://centrifugal.dev/docs/server/server_api#grpc_apierror_mode "Direct link to grpc_apierror_mode")

Type: `string`

Env: `CENTRIFUGO_GRPC_API_ERROR_MODE`

Allows setting `transport` as an error mode. See [Transport error mode](https://centrifugal.dev/docs/server/server_api#transport-error-mode) for the details.

#### `grpc_api.address`[](https://centrifugal.dev/docs/server/server_api#grpc_apiaddress "Direct link to grpc_apiaddress")

Type: `string`

Env: `CENTRIFUGO_GRPC_API_ADDRESS`

Custom address to run GRPC API server on.

#### `grpc_api.port`[](https://centrifugal.dev/docs/server/server_api#grpc_apiport "Direct link to grpc_apiport")

Type: `int`. Default: `10000`

Env: `CENTRIFUGO_GRPC_API_PORT`

Port on which GRPC API server runs.

#### `grpc_api.key`[](https://centrifugal.dev/docs/server/server_api#grpc_apikey "Direct link to grpc_apikey")

Type: `string`

Env: `CENTRIFUGO_GRPC_API_KEY`

Allows to enable per RPC auth. If key is set to a non-empty string then clients should provide per RPC credentials: set `authorization` key to metadata with a value `apikey <KEY>`.

#### `grpc_api.tls`[](https://centrifugal.dev/docs/server/server_api#grpc_apitls "Direct link to grpc_apitls")

Type: [TLSConfig](https://centrifugal.dev/docs/server/configuration#tls-config-object) object.

TLS config for GRPC server.

#### `grpc_api.reflection`[](https://centrifugal.dev/docs/server/server_api#grpc_apireflection "Direct link to grpc_apireflection")

Type: `bool`

Env: `CENTRIFUGO_GRPC_API_REFLECTION`

Enables GRPC reflection API for introspection.

#### `grpc_api.max_receive_message_size`[](https://centrifugal.dev/docs/server/server_api#grpc_apimax_receive_message_size "Direct link to grpc_apimax_receive_message_size")

Type: `int`

Env: `CENTRIFUGO_GRPC_API_MAX_RECEIVE_MESSAGE_SIZE`

If set to a value > 0 allows tuning the max size of message GRPC server can receive. By default, GRPC library's default is used which is 4194304 bytes (4MB).

### GRPC example for Python[](https://centrifugal.dev/docs/server/server_api#grpc-example-for-python "Direct link to GRPC example for Python")

For example for Python you need to run sth like this according to GRPC docs:

```lua
pip install grpcio-toolspython -m grpc_tools.protoc -I ./ --python_out=. --grpc_python_out=. api.proto
```

As soon as you run the command you will have 2 generated files: `api_pb2.py` and `api_pb2_grpc.py`. Now all you need is to write a simple program that uses generated code and sends GRPC requests to Centrifugo:

```csharp
import grpcimport api_pb2_grpc as api_grpcimport api_pb2 as api_pbchannel = grpc.insecure_channel('localhost:10000')stub = api_grpc.CentrifugoApiStub(channel)try:    resp = stub.Info(api_pb.InfoRequest())except grpc.RpcError as err:    # GRPC level error.    print(err.code(), err.details())else:    if resp.error.code:        # Centrifugo server level error.        print(resp.error.code, resp.error.message)    else:        print(resp.result)
```

Note that you need to explicitly handle Centrifugo API level error which is not transformed automatically into GRPC protocol-level error.

### GRPC example for Go[](https://centrifugal.dev/docs/server/server_api#grpc-example-for-go "Direct link to GRPC example for Go")

Here is a simple example of how to run Centrifugo with the GRPC Go client.

You need `protoc`, `protoc-gen-go` and `protoc-gen-go-grpc` installed.

First start Centrifugo itself with GRPC API enabled:

```ini
CENTRIFUGO_GRPC_API=1 centrifugo --config config.json
```

In another terminal tab:

```swift
mkdir centrifugo_grpc_examplecd centrifugo_grpc_example/touch main.gogo mod init centrifugo_examplemkdir apiprotocd apiprotowget https://raw.githubusercontent.com/centrifugal/centrifugo/master/internal/apiproto/api.proto -O api.proto
```

Run `protoc` to generate code:

```go
protoc -I ./ api.proto --go_out=. --go-grpc_out=.
```

Put the following code to `main.go` file (created on the last step above):

```go
package mainimport (    "context"    "log"    "time"    "centrifugo_example/apiproto"    "google.golang.org/grpc")func main() {    conn, err := grpc.Dial("localhost:10000", grpc.WithInsecure())    if err != nil {        log.Fatalln(err)    }    defer conn.Close()    client := apiproto.NewCentrifugoApiClient(conn)    for {        resp, err := client.Publish(context.Background(), &apiproto.PublishRequest{            Channel: "chat:index",            Data:    []byte(`{"input": "hello from GRPC"}`),        })        if err != nil {            log.Printf("Transport level error: %v", err)        } else {            if resp.GetError() != nil {                respError := resp.GetError()                log.Printf("Error %d (%s)", respError.Code, respError.Message)            } else {                log.Println("Successfully published")            }        }        time.Sleep(time.Second)    }}
```

Then run:

```go
go run main.go
```

The program starts and periodically publishes the same payload into `chat:index` channel.

### Integration with Buf schema registry[](https://centrifugal.dev/docs/server/server_api#integration-with-buf-schema-registry "Direct link to Integration with Buf schema registry")

We publish [Centrifugo GRPC API Protobuf definitions](https://buf.build/centrifugo/apiproto/docs/main:centrifugal.centrifugo.api) to [Buf Schema Registry](https://buf.build/product/bsr). This means that to use Centrifugo GRPC APIs it's possible to depend on pre-generated Protobuf definitions for your programming language instead of manually generating them from the schema file (see [SDKs supported by Buf registry here](https://buf.build/centrifugo/apiproto/sdks)).

caution

Note, Centrifugo is not compatible with Buf Connect HTTP protocol – i.e. you can use Buf tools to communicate with Centrifugo GRPC API only.

### GRPC API key authorization[](https://centrifugal.dev/docs/server/server_api#grpc-api-key-authorization "Direct link to GRPC API key authorization")

You can also set `grpc_api.key` option (string) in Centrifugo configuration to protect GRPC API with key. In this case, you should set per RPC metadata with key `authorization` and value `apikey <KEY>`. For example in Go language:

```go
package mainimport (    "context"    "log"    "time"    "centrifugo_example/apiproto"        "google.golang.org/grpc")type keyAuth struct {    key string}func (t keyAuth) GetRequestMetadata(ctx context.Context, uri ...string) (map[string]string, error) {    return map[string]string{        "authorization": "apikey " + t.key,    }, nil}func (t keyAuth) RequireTransportSecurity() bool {    return false}func main() {    conn, err := grpc.Dial("localhost:10000", grpc.WithInsecure(), grpc.WithPerRPCCredentials(keyAuth{"xxx"}))    if err != nil {        log.Fatalln(err)    }    defer conn.Close()    client := apiproto.NewCentrifugoClient(conn)    for {        resp, err := client.Publish(context.Background(), &PublishRequest{            Channel: "chat:index",            Data:    []byte(`{"input": "hello from GRPC"}`),        })        if err != nil {            log.Printf("Transport level error: %v", err)        } else {            if resp.GetError() != nil {                respError := resp.GetError()                log.Printf("Error %d (%s)", respError.Code, respError.Message)            } else {                log.Println("Successfully published")            }        }        time.Sleep(time.Second)    }}
```

For other languages refer to GRPC docs.

## Transport error mode[](https://centrifugal.dev/docs/server/server_api#transport-error-mode "Direct link to Transport error mode")

By default, Centrifugo server API never returns transport level errors - for example it always returns 200 OK for HTTP API and never returns GRPC transport-level errors. Centrifugo returns its custom errors from API calls inside optional `error` field of response as we showed above in this doc. This means that API call to Centrifigo API may returns 200 OK, but in the `error` field you may find Centrifugo-specific `100: internal error`.

Since Centrifugo v5.1.0 Centrifigo has an option to use transport-native error codes instead of Centrifugo `error` field in the response. The main motivation is make API calls friendly to integrate with the network ecosystem - for automatic retries, better logging, etc. In many situations this may be more obvious for humans also.

Let's show an example. Without any special options HTTP request to Centrifigo server API which contains error in response looks like this:

```bash
❯ echo '{}' | http POST "http://localhost:8000/api/publish"HTTP/1.1 200 OKContent-Length: 46Content-Type: application/jsonDate: Sat, 19 Aug 2023 07:23:40 GMT{    "error": {        "code": 107,        "message": "bad request"    }}
```

Note - it returns 200 OK even though response contains `error` field. With `transport` error mode request-response may be transformed into the following:

```bash
❯ echo '{}' | http POST "http://localhost:8000/api/publish" "X-Centrifugo-Error-Mode: transport"HTTP/1.1 400 Bad RequestContent-Length: 36Content-Type: application/jsonDate: Sat, 19 Aug 2023 07:23:59 GMT{    "code": 107,    "message": "bad request"}
```

Transport error mode may be turned on globally:

-   using `"http_api.error_mode"` option with `"transport"` value for HTTP server API
-   using `"grpc_api.error_mode"` option with `"transport"` value for GRPC server API

Example:

config.json

```json
{    "http_api": {        "error_mode": "transport"    }}
```

Also, this mode may be used on per-request basis:

-   by setting custom header `X-Centrifugo-Error-Mode: transport` for HTTP (as we just showed in the example)
-   adding custom metadata key `x-centrifugo-error-mode: transport` for GRPC

caution

Note, that `transport` error mode does not help a lot with `Batch` and `Broadcast` APIs which are quite special because these calls contain many independent operations. For these calls you still need to look at individual `error` objects in response.

To achieve the goal we have an internal matching of Centrifugo API error codes to HTTP and GRPC error codes.

### Centrifugo error code to HTTP code[](https://centrifugal.dev/docs/server/server_api#centrifugo-error-code-to-http-code "Direct link to Centrifugo error code to HTTP code")

```ruby
func MapErrorToHTTPCode(err *Error) int {switch err.Code {case ErrorInternal.Code: // 100 -> HTTP 500return http.StatusInternalServerErrorcase ErrorUnknownChannel.Code, ErrorNotFound.Code: // 102, 104 -> HTTP 404return http.StatusNotFoundcase ErrorBadRequest.Code, ErrorNotAvailable.Code: // 107, 108 -> HTTP 400return http.StatusBadRequestcase ErrorUnrecoverablePosition.Code: // 112 -> HTTP 416return http.StatusRequestedRangeNotSatisfiablecase ErrorConflict.Code: // 113 -> HTTP 409return http.StatusConflictdefault:// Default to Internal Error for unmapped errors.// In general should be avoided - all new API errors must be explicitly described here.return http.StatusInternalServerError // HTTP 500}}
```

### Centrifugo error code to GRPC code[](https://centrifugal.dev/docs/server/server_api#centrifugo-error-code-to-grpc-code "Direct link to Centrifugo error code to GRPC code")

```ruby
func MapErrorToGRPCCode(err *Error) codes.Code {switch err.Code {case ErrorInternal.Code: // 100return codes.Internalcase ErrorUnknownChannel.Code, ErrorNotFound.Code: // 102, 104return codes.NotFoundcase ErrorBadRequest.Code, ErrorNotAvailable.Code: // 107, 108return codes.InvalidArgumentcase ErrorUnrecoverablePosition.Code: // 112return codes.OutOfRangecase ErrorConflict.Code: // 113return codes.AlreadyExistsdefault:// Default to Internal Error for unmapped errors.// In general should be avoided - all new API errors must be explicitly described here.return codes.Internal}}
```
