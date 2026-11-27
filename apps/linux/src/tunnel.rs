// The dev browser's proxy: a SOCKS5 listener on loopback that its webviews use.
// A loopback target goes to the deck machine (or a remote session's host) over
// one WebSocket to deck's /api/tunnel per connection; any other host is reached
// directly. DevTunnel.swift does the same on Apple. A password only the
// browser's webviews are given keeps other local users off it.

use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
use url::Url;

use crate::core::{is_local_ip, is_tunnel_target, tunnel_url};

pub const USER: &str = "deck";

// Where tunnelled connections go. The token is replaced when the browser opens
// again, so a rotated token takes effect without a restart.
pub struct Route {
	pub server: Url,
	pub token: String,
	pub session: Option<String>,
}

pub struct Proxy {
	pub port: u16,
	pub password: String,
	pub route: Arc<Mutex<Route>>,
}

impl Proxy {
	// The proxy URI for WebKit, credentials included.
	pub fn uri(&self) -> String {
		format!("socks5://{USER}:{}@127.0.0.1:{}", self.password, self.port)
	}
}

fn random_password() -> std::io::Result<String> {
	let mut bytes = [0u8; 16];
	std::io::Read::read_exact(&mut std::fs::File::open("/dev/urandom")?, &mut bytes)?;
	Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

pub async fn start(route: Route) -> std::io::Result<Proxy> {
	let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
	let proxy = Proxy { port: listener.local_addr()?.port(), password: random_password()?, route: Arc::new(Mutex::new(route)) };
	let password: Arc<str> = proxy.password.clone().into();
	let route = proxy.route.clone();
	tokio::spawn(async move {
		while let Ok((client, _)) = listener.accept().await {
			let (password, route) = (password.clone(), route.clone());
			tokio::spawn(async move {
				if let Err(e) = serve(client, &password, &route).await {
					eprintln!("deck: dev browser connection failed: {e}");
				}
			});
		}
	});
	Ok(proxy)
}

type Error = Box<dyn std::error::Error + Send + Sync>;

// RFC 1928 with RFC 1929 username/password auth, CONNECT only.
async fn serve(mut client: TcpStream, password: &str, route: &Mutex<Route>) -> Result<(), Error> {
	let mut head = [0u8; 2];
	client.read_exact(&mut head).await?;
	if head[0] != 5 {
		return Err("not SOCKS5".into());
	}
	let mut methods = vec![0u8; head[1] as usize];
	client.read_exact(&mut methods).await?;
	if !methods.contains(&2) {
		client.write_all(&[5, 0xff]).await?;
		return Err("no password offered".into());
	}
	client.write_all(&[5, 2]).await?;
	let user = read_field(&mut client, true).await?;
	let pass = read_field(&mut client, false).await?;
	let ok = user == USER.as_bytes() && pass.len() == password.len() && pass.iter().zip(password.bytes()).fold(0, |d, (a, b)| d | (a ^ b)) == 0;
	client.write_all(&[1, if ok { 0 } else { 1 }]).await?;
	if !ok {
		return Err("wrong proxy password".into());
	}

	let mut req = [0u8; 4];
	client.read_exact(&mut req).await?;
	if req[1] != 1 {
		reply(&mut client, 7).await?;
		return Err("only CONNECT is supported".into());
	}
	let host = match req[3] {
		1 => {
			let mut ip = [0u8; 4];
			client.read_exact(&mut ip).await?;
			std::net::Ipv4Addr::from(ip).to_string()
		}
		3 => String::from_utf8(read_field(&mut client, false).await?)?,
		4 => {
			let mut ip = [0u8; 16];
			client.read_exact(&mut ip).await?;
			std::net::Ipv6Addr::from(ip).to_string()
		}
		_ => {
			reply(&mut client, 8).await?;
			return Err("unknown address type".into());
		}
	};
	let port = client.read_u16().await?;

	if !is_tunnel_target(&host) {
		// Resolved here once, and the connection uses the addresses checked. Only
		// literal loopback names are tunnelled: another name that resolves to
		// loopback (a rebinding DNS name) is refused, or a page on it could read
		// the deck machine's dev servers as its own origin.
		let addrs: Vec<_> = match tokio::net::lookup_host((host.as_str(), port)).await {
			Ok(addrs) => addrs.collect(),
			Err(e) => {
				reply(&mut client, 4).await?;
				return Err(e.into());
			}
		};
		if addrs.iter().any(|a| is_local_ip(a.ip())) {
			reply(&mut client, 2).await?;
			return Err(format!("{host} resolves to loopback but is not a loopback name").into());
		}
		let mut target = match TcpStream::connect(&addrs[..]).await {
			Ok(t) => t,
			Err(e) => {
				reply(&mut client, 5).await?;
				return Err(e.into());
			}
		};
		reply(&mut client, 0).await?;
		tokio::io::copy_bidirectional(&mut client, &mut target).await?;
		return Ok(());
	}

	// No Origin header (tungstenite sends none): the server refuses one.
	let request = {
		let route = route.lock().unwrap();
		let mut request = tunnel_url(&route.server, port, route.session.as_deref()).as_str().into_client_request()?;
		request.headers_mut().insert("Authorization", format!("Bearer {}", route.token).parse()?);
		request
	};
	let ws = match tokio_tungstenite::connect_async(request).await {
		Ok((ws, _)) => ws,
		Err(e) => {
			reply(&mut client, 5).await?;
			return Err(format!("tunnel to port {port}: {e}").into());
		}
	};
	reply(&mut client, 0).await?;
	pump(client, ws).await
}

// The bytes both ways until either side ends. Pings from the server are
// answered by tungstenite as the stream is read.
async fn pump(client: TcpStream, ws: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>) -> Result<(), Error> {
	let (mut sink, mut stream) = ws.split();
	let (mut rd, mut wr) = client.into_split();
	let up = async {
		let mut buf = vec![0u8; 32 * 1024];
		loop {
			let n = rd.read(&mut buf).await?;
			if n == 0 {
				break;
			}
			sink.send(Message::binary(buf[..n].to_vec())).await?;
		}
		sink.close().await?;
		Ok::<_, Error>(())
	};
	let down = async {
		while let Some(message) = stream.next().await {
			match message? {
				Message::Binary(bytes) => wr.write_all(&bytes).await?,
				Message::Close(_) => break,
				_ => {}
			}
		}
		wr.shutdown().await?;
		Ok::<_, Error>(())
	};
	tokio::select! {
		r = up => r,
		r = down => r,
	}
}

async fn read_field(client: &mut TcpStream, versioned: bool) -> std::io::Result<Vec<u8>> {
	if versioned {
		client.read_u8().await?;
	}
	let len = client.read_u8().await? as usize;
	let mut field = vec![0u8; len];
	client.read_exact(&mut field).await?;
	Ok(field)
}

async fn reply(client: &mut TcpStream, code: u8) -> std::io::Result<()> {
	client.write_all(&[5, code, 0, 1, 0, 0, 0, 0, 0, 0]).await
}

#[cfg(test)]
mod tests {
	use super::*;
	use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

	// A stand-in deck: records each upgrade's path and auth header, then echoes.
	async fn fake_deck() -> (Url, Arc<Mutex<Vec<(String, String, bool)>>>) {
		let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
		let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
		let seen = Arc::new(Mutex::new(Vec::new()));
		let log = seen.clone();
		tokio::spawn(async move {
			while let Ok((socket, _)) = listener.accept().await {
				let log = log.clone();
				tokio::spawn(async move {
					let record = |req: &Request, res: Response| {
						let auth = req.headers().get("authorization").map(|v| v.to_str().unwrap().to_string()).unwrap_or_default();
						log.lock().unwrap().push((req.uri().to_string(), auth, req.headers().contains_key("origin")));
						Ok(res)
					};
					let mut ws = tokio_tungstenite::accept_hdr_async(socket, record).await.unwrap();
					while let Some(Ok(m)) = ws.next().await {
						if m.is_binary() {
							ws.send(m).await.unwrap();
						}
					}
				});
			}
		});
		(url, seen)
	}

	async fn socks(proxy: &Proxy, password: &str, connect: &[u8]) -> (TcpStream, Vec<u8>) {
		let mut c = TcpStream::connect(("127.0.0.1", proxy.port)).await.unwrap();
		c.write_all(&[5, 1, 2]).await.unwrap();
		let mut b = [0u8; 2];
		c.read_exact(&mut b).await.unwrap();
		assert_eq!(b, [5, 2]);
		let mut auth = vec![1, USER.len() as u8];
		auth.extend(USER.bytes());
		auth.push(password.len() as u8);
		auth.extend(password.bytes());
		c.write_all(&auth).await.unwrap();
		c.read_exact(&mut b).await.unwrap();
		if b[1] != 0 {
			return (c, b.to_vec());
		}
		c.write_all(connect).await.unwrap();
		let mut r = [0u8; 10];
		c.read_exact(&mut r).await.unwrap();
		(c, r.to_vec())
	}

	fn domain(host: &str, port: u16) -> Vec<u8> {
		let mut v = vec![5, 1, 0, 3, host.len() as u8];
		v.extend(host.bytes());
		v.extend(port.to_be_bytes());
		v
	}

	#[tokio::test]
	async fn loopback_goes_through_the_tunnel_with_the_token_in_a_header() {
		let (server, seen) = fake_deck().await;
		let proxy = start(Route { server, token: "s3cret".into(), session: Some("abc-1".into()) }).await.unwrap();
		let (mut c, r) = socks(&proxy, &proxy.password.clone(), &domain("localhost", 5173)).await;
		assert_eq!(r[1], 0);
		c.write_all(b"GET / HTTP/1.1\r\n\r\n").await.unwrap();
		let mut echo = [0u8; 18];
		c.read_exact(&mut echo).await.unwrap();
		assert_eq!(&echo, b"GET / HTTP/1.1\r\n\r\n");
		let (_, r) = socks(&proxy, &proxy.password.clone(), &[5, 1, 0, 1, 127, 0, 0, 1, 0x0b, 0xb8]).await;
		assert_eq!(r[1], 0);
		let (_, r) = socks(&proxy, &proxy.password.clone(), &domain("127.1", 8080)).await;
		// 127.1 stands in for a rebinding DNS name: not literal, resolves to loopback.
		assert_eq!(r[1], 2, "a name that resolves to loopback is refused, neither tunnelled nor connected to here");
		let seen = seen.lock().unwrap().clone();
		assert_eq!(seen[0], ("/api/tunnel?port=5173&session=abc-1".into(), "Bearer s3cret".into(), false));
		assert_eq!(seen[1].0, "/api/tunnel?port=3000&session=abc-1");
		assert_eq!(seen.len(), 2);
	}

	#[tokio::test]
	async fn a_wrong_password_is_refused() {
		let (server, seen) = fake_deck().await;
		let proxy = start(Route { server, token: "t".into(), session: None }).await.unwrap();
		let (_, r) = socks(&proxy, "guess", &domain("localhost", 5173)).await;
		assert_eq!(r, [1, 1]);
		assert!(seen.lock().unwrap().is_empty());
	}

	#[tokio::test]
	async fn other_hosts_are_reached_directly() {
		let (server, seen) = fake_deck().await;
		let proxy = start(Route { server, token: "t".into(), session: None }).await.unwrap();
		let (_, r) = socks(&proxy, &proxy.password.clone(), &domain("nothing.invalid", 80)).await;
		assert_eq!(r[1], 4, "a host that fails to resolve is reported, not tunnelled");
		assert!(seen.lock().unwrap().is_empty());
	}
}
