# SpeedRun: Escape From Tsunami — Online Multiplayer + Global Leaderboard

Game 3D (Three.js) dengan multiplayer online jarak jauh dan **Global Leaderboard** berbasis PostgreSQL. Pemain dengan Wi-Fi, kuota Telkomsel, atau operator lain bisa bermain bersama dan bersaing di peringkat dunia.

## Isi project

| File | Fungsi |
|---|---|
| `index.html` | Game lengkap (Singleplayer, Multiplayer online, halaman Global Leaderboard) |
| `server.js` | Backend: WebSocket relay + pengelola room + API akun/leaderboard + penyaji `index.html` |
| `db.js` | Lapisan PostgreSQL: skema otomatis, ranking, penambahan PTS yang idempotent |
| `dbconfig.js` | Membaca `DATABASE_URL` (membersihkan format salah, SSL otomatis) dan menerjemahkan error database jadi petunjuk yang jelas |
| `scripts/db-check.js` | `npm run db:check`: tes koneksi database + buat tabel, hasilnya mudah dibaca |
| `PANDUAN-ANDROID.md` | Panduan langkah demi langkah (Neon + Suga) dari HP Android |
| `auth.js` | Akun: validasi, hash password (scrypt), token login bertanda tangan, rate limit |
| `tournament.js` | Pelacak Tournament di server: menentukan Tournament mana yang sah dan siapa dapat PTS |
| `test/run.js` | Tes end-to-end (`npm test`) |
| `package.json` | Dependency (`ws`, `pg`) dan perintah `npm start` |
| `.env.example` | Daftar environment variable |
| `cfdedc2208396c584eb11f51327f92c3.jpg` | Gambar bawaan project |

---

## Fitur Global Leaderboard

- Tombol **🏆 GLOBAL LEADERBOARD** di Main Menu membuka halaman peringkat (ada tombol **Back**, **Refresh**, dan indikator loading).
- Peringkat berdasarkan **total PTS Tournament online**. Sistem PTS lama tidak diubah: tabel 10/8/6/5/4/3/2/1 per ronde tetap sama.
- Daftar utama hanya **Top 100**: peringkat, username, total PTS.
- **Tie-breaker** (PTS sama): pemain yang *lebih dulu mencapai* total PTS itu ada di atas. Jika waktunya sama persis, akun yang lebih lama dibuat ada di atas. Urutan selalu sama.
- Di bagian bawah halaman selalu ada kotak **My Rank** dan **My PTS**. Pemain di luar Top 100 hanya melihat datanya sendiri, misalnya `My Rank: #1254`. Daftar pemain di luar Top 100 tidak pernah dikirim ke klien.
- Peringkat diambil dengan dua request ringan yang terpisah: Top 100 (di-cache server 3 detik) dan data diri sendiri. Halaman otomatis menyegarkan diri tiap 30 detik saat dibuka.
- Tidak ada data contoh. Leaderboard kosong sampai ada Tournament online yang benar-benar selesai.

### Akun (identitas pemain)

Peringkat global butuh identitas yang sama di semua perangkat, jadi ada **akun global**:

- Daftar / login langsung dari halaman Global Leaderboard (username 3–16 karakter huruf/angka/`_`, password minimal 6 karakter).
- Username unik tanpa membedakan huruf besar/kecil ("Ali" dan "ali" tidak bisa ada bersamaan), sehingga tidak ada akun ganda.
- Password disimpan sebagai hash **scrypt**. Token login bertanda tangan (HMAC), berlaku 90 hari. Browser hanya menyimpan token itu, bukan data leaderboard.
- Nama pemain di Settings tidak berubah dan tidak terkait akun. Leaderboard memakai username akun.
- Game tetap bisa dimainkan **tanpa login**. Pemain tanpa login hanya tidak mendapat PTS global (muncul pesan pengingat setelah Tournament).

### Aturan PTS (dihitung server, bukan klien)

Klien **tidak pernah mengirim angka PTS**. Server memantau pesan `start`/`end` yang sudah dikirim host ke room dan menghitung sendiri. PTS masuk hanya jika:

1. Tournament online (room multiplayer) dan **semua ronde** sudah dimulai berurutan, serta **ronde terakhir selesai**.
2. Tiap ronde berlangsung wajar (minimal `MIN_ROUND_SECONDS`, bawaan 30 detik) dan hasilnya peringkat bersih 1..N dengan ID pemain yang memang ada di ronde itu.
3. Pemain ikut **setiap ronde** dengan akun login yang **sama**. Pemain yang keluar di tengah, atau masuk terlambat (jadi penonton), tidak dapat PTS.
4. Minimal 2 pemain manusia menyelesaikannya. Satu manusia melawan bot tidak dihitung.
5. Satu akun yang terhubung dua kali di room yang sama tidak mendapat PTS.

Tidak masuk leaderboard: Single Round, Singleplayer/offline melawan bot, ronde Tournament yang belum selesai, Tutorial.

PTS = jumlah `TPTS[peringkat-1]` tiap ronde (peringkat di atas 8 = 1 PTS). Nilai ini dihitung ulang di server dari peringkat, sehingga field `pts` yang dikirim klien diabaikan.

### Keamanan dan konsistensi

- **Anti dobel**: setiap Tournament mendapat ID unik dari server. Tabel `tournament_results` punya `UNIQUE (tournament_id, user_id)`, dan penambahan PTS dilakukan dalam satu transaksi dengan row lock. Pesan yang terkirim ulang atau koneksi yang putus-nyambung tidak bisa menambah PTS dua kali.
- **Tidak ada endpoint untuk mengirim skor.** Satu-satunya jalan PTS bertambah adalah Tournament yang disahkan server (diuji di `test/run.js`).
- **Batas anti-farming** per akun: `MAX_TOURNAMENTS_PER_HOUR` (12) dan `MAX_TOURNAMENTS_PER_DAY` (100). Pemain normal tidak akan menyentuhnya.
- Rate limit untuk login (per IP dan per akun), pendaftaran (per IP), dan semua API.
- Jika internet putus atau server/database tidak bisa dijangkau, halaman menampilkan pesan yang jelas dan tombol *Try again*. Data lama yang sudah tampil tidak dihapus.

> **Batasan jujur yang perlu diketahui.** Game ini *host authority*: simulasi balapan berjalan di perangkat host, dan server hanya merelay. Server tidak bisa melihat balapannya sendiri. Karena itu server memvalidasi alur, waktu, struktur, identitas, dan dobelnya, tetapi **tidak bisa membuktikan** bahwa peringkat yang dilaporkan host benar-benar terjadi. Host yang memodifikasi kliennya *dan* memakai akun kedua sebagai lawan masih bisa memalsukan hasil, hanya dalam batas laju di atas (maks. 90 PTS per Tournament, dan batas per jam/hari). Untuk anti-curang yang kedap, simulasi game harus dijalankan di server, yang berarti menulis ulang game. Jika perlu, akun pelaku bisa dihapus langsung di database (`DELETE FROM users WHERE username_lower = '...'`).

---

## Konfigurasi database dan deployment

> **Pesan "no database configured" di Global Leaderboard?** Server belum menerima `DATABASE_URL`. Ikuti **[PANDUAN-ANDROID.md](PANDUAN-ANDROID.md)** (database gratis Neon + Suga). Cek hasilnya di `https://URL-ANDA/health`: harus `"ready":true`; jika tidak, field `hint` menjelaskan apa yang salah.

### Pengecekan koneksi saat server dijalankan

Setiap start, server: (1) membaca `DATABASE_URL`, (2) terhubung ke database, (3) membuat/memperbarui tabel `users`, `tournament_results`, `app_secrets`, (4) membaca kembali tabel dan menjalankan query Top 100, lalu mencetak ringkasan di log (`database READY: ... players=N ranked=N`). Jika gagal, log dan `/health` menampilkan penyebab dan cara memperbaikinya, lalu server mencoba lagi otomatis (5 detik, bertahap sampai 30 detik). `DATABASE_URL` yang kosong, masih berisi contoh (`USER:PASSWORD@HOST`), atau salah format langsung dilaporkan dengan pesan jelas. Dengan `REQUIRE_DATABASE=true` server menolak start dalam kondisi itu.

Tes manual tanpa menjalankan server: `DATABASE_URL=... npm run db:check`.

### 1. Buat database PostgreSQL online

Pilih salah satu (semuanya punya paket gratis, cek syarat terbarunya di situs masing-masing):

- **Neon** (neon.tech), **Supabase** (supabase.com), **Render PostgreSQL**, atau **Railway PostgreSQL**.

Setelah database dibuat, salin **connection string** (bentuknya `postgres://user:password@host:5432/dbname`). Alamat koneksi pooler (mode transaksi) juga didukung.

Tabel dibuat **otomatis** saat server pertama kali jalan (tidak perlu SQL manual). Tabel yang dibuat: `users`, `tournament_results`, `app_secrets`.

### 2. Atur environment variable di hosting

| Variabel | Wajib | Keterangan |
|---|---|---|
| `DATABASE_URL` | **ya** | Connection string PostgreSQL (nama alternatif `POSTGRES_URL`, `POSTGRESQL_URL`, `DATABASE_PRIVATE_URL`, dst. juga dikenali, serta `PGHOST`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`). Boleh ditempel apa adanya, termasuk `psql '...'` dari Neon; password berisi karakter khusus (`@ # / ?`) aman. Tanpa ini game dan multiplayer tetap jalan, tetapi leaderboard nonaktif dan menampilkan pesan jelas. |
| `DATABASE_SSL` | tidak | **Otomatis**: SSL aktif untuk database online, mati untuk `localhost`/jaringan internal; juga membaca `?sslmode=` di URL. Server mencoba sisi sebaliknya sekali jika tebakan salah. Isi `true`/`false` hanya untuk memaksa. |
| `REQUIRE_DATABASE` | tidak | `true` = server berhenti jika `DATABASE_URL` kosong/salah format (bawaan: game tetap jalan tanpa leaderboard). |
| `AUTH_SECRET` | disarankan | Kunci penanda token login, minimal 16 karakter acak. Jika kosong, server membuat kunci acak dan menyimpannya di database, sehingga tetap konsisten setelah restart. Jangan ubah nilainya, karena semua orang harus login ulang. |
| `PORT` | otomatis | Diisi hosting. Jangan ditulis manual. |
| `MIN_ROUND_SECONDS` | tidak | Durasi minimal sebuah ronde agar sah (30). |
| `TOURNAMENT_MIN_HUMANS` | tidak | Minimal pemain manusia yang menyelesaikan Tournament (2). |
| `MAX_TOURNAMENTS_PER_HOUR` / `_PER_DAY` | tidak | Batas PTS per akun (12 / 100). |
| `DATABASE_POOL_MAX` | tidak | Ukuran pool koneksi (10). |

Variabel multiplayer lama (`ALLOWED_ORIGINS`, `MAX_ROOMS`, `MAX_CONN_PER_IP`, dst.) tetap berlaku, lihat tabel di bawah.

### 3. Deploy (GitHub + Suga, Render, Railway, atau sejenisnya)

1. Upload semua file ke repository GitHub (`.gitignore` sudah mengecualikan `node_modules` dan `.env`).
2. Buat service Node.js dari repository itu:
   - Build/install: `npm install`
   - Start: `npm start`
3. Isi environment variable dari langkah 2, lalu deploy.
4. Buka `https://URL-ANDA/health`. Hasil yang benar:
   `{"ok":true,...,"leaderboard":{"configured":true,"ready":true,...}}`
   Jika `ready` masih `false`, baca field `hint` (dan log server): berisi penyebabnya (password salah, nama database salah, SSL, host tidak terjangkau) dan cara memperbaikinya. Server mencoba lagi otomatis.
5. Buka game, tekan **GLOBAL LEADERBOARD**, buat akun, lalu mainkan Tournament online bersama minimal satu pemain lain.

Game dan backend ada di satu alamat, jadi tidak perlu konfigurasi URL tambahan. Jika `index.html` dihosting terpisah (misalnya GitHub Pages), URL backend yang diatur lewat `?server=wss://...` atau *Connection settings* otomatis dipakai juga untuk API leaderboard (`wss://` menjadi `https://`). Isi `ALLOWED_ORIGINS` dengan alamat situs game tersebut.

### 4. Menjalankan di komputer sendiri

```bash
# database lokal sekali jalan (butuh Docker)
docker run -d --name speedrun-db -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=speedrun -p 5432:5432 postgres:16

npm install
DATABASE_URL=postgres://postgres:pw@localhost:5432/speedrun npm start       # SSL otomatis mati untuk localhost
npm run test:config      # tes pembacaan DATABASE_URL (tanpa database)
DATABASE_URL=... npm run db:check
```

Buka `http://localhost:3000`. Untuk menjalankan tes (**menghapus isi tabel**, pakai database khusus tes):

```bash
TEST_DATABASE_URL=postgres://postgres:pw@localhost:5432/speedrun DATABASE_SSL=false npm test
```

### 5. Catatan operasional

- **Data permanen**: semua akun dan PTS ada di PostgreSQL, bukan di memori server atau `localStorage`. Restart atau deploy ulang tidak menghapusnya. Aktifkan backup otomatis dari penyedia database Anda.
- **Multiplayer tetap 1 instance**: room disimpan di memori satu proses, jadi jalankan hanya **1 instance** (sama seperti sebelumnya). Leaderboard sendiri aman diakses dari banyak instance.
- **Hosting gratis yang "tidur"**: request pertama bisa lambat. Halaman memberi batas waktu 10 detik, lalu pesan error dan tombol coba lagi.
- **Reset leaderboard**: `UPDATE users SET total_pts = 0, tournaments = 0; TRUNCATE tournament_results;`
- **Hitung ulang total dari riwayat** (jika perlu audit): `UPDATE users u SET total_pts = COALESCE((SELECT SUM(pts) FROM tournament_results r WHERE r.user_id = u.id), 0);`
- Pemain yang sudah punya koin/progres di perangkatnya tidak terpengaruh. Semua data lokal lama dibiarkan apa adanya.

---

## Cara kerja multiplayer (tidak berubah)

- **Host authority**: pemain yang membuat server (HOST) menjalankan simulasi game (bot, tsunami, item). `server.js` mengelola room dan meneruskan pesan.
- Semua koneksi memakai **WebSocket**. Di halaman HTTPS otomatis memakai **WSS**. Koneksi WebSocket kini juga mengirim token login (`auth`) agar server tahu akun pemain di room.
- Room disimpan **in-memory**. Server yang restart berarti room yang sedang berjalan hilang (akun dan PTS aman di database).

## Konfigurasi URL backend

Jika `index.html` dihosting di tempat yang berbeda dari `server.js`, arahkan game ke backend (urutan prioritas):

1. **Parameter URL**: `https://situs-anda/?server=wss://backend-anda.example.com`
2. **Menu game**: Multiplayer → *Connection settings* → isi URL → *Save & Test*.
3. **Di kode**: ubah `var SERVER_URL_DEFAULT='';` di `index.html`.
4. Jika kosong semua: memakai alamat yang menyajikan halaman.

## Variabel environment multiplayer (opsional)

| Variabel | Default | Keterangan |
|---|---|---|
| `ALLOWED_ORIGINS` | kosong (semua) | Origin yang boleh konek (WebSocket dan API), pisahkan dengan koma. Contoh: `https://user.github.io` |
| `MAX_PLAYERS` | 8 | Batas pemain per room (maks. 8) |
| `MAX_ROOMS` | 300 | Batas jumlah room |
| `MAX_CONN_PER_IP` | 40 | Batas koneksi per IP |
| `RECONNECT_GRACE_MS` | 15000 | Slot dipertahankan selama ini setelah koneksi putus |
| `MSG_RATE_PER_SEC` | 120 | Batas pesan per detik per koneksi |
| `MAX_MSG_BYTES` | 65536 | Ukuran pesan maksimum |
| `TRUST_PROXY` | aktif | Set `0` jika server tidak di belakang reverse proxy (IP klien dipakai untuk rate limit) |

## Fitur multiplayer

- **Server List**, **Create Server**, **Private Server** (ID 6 karakter), **Lobby** dengan chat, late join, reconnect otomatis (slot dipertahankan 15 detik), indikator koneksi dan ping, anti-spam, dan hemat data. Semuanya tidak berubah.

## Endpoint HTTP

| Endpoint | Fungsi |
|---|---|
| `GET /` | game |
| `GET /health` | status server dan database |
| `GET /api/servers` | daftar server publik |
| `GET /api/leaderboard` | Top 100: `{top:[{rank,username,pts}], total, updatedAt}` |
| `GET /api/leaderboard/me` | peringkat dan PTS akun sendiri (header `Authorization: Bearer <token>`) |
| `POST /api/auth/register` | `{username, password}` → `{token, user}` |
| `POST /api/auth/login` | `{username, password}` → `{token, user}` |
| `GET /api/auth/me` | validasi token |

## Catatan

- Three.js dimuat dari CDN (`cdnjs.cloudflare.com`), jadi pemain perlu internet.
- Pesan WebSocket baru: klien → server `auth`; server → klien `authed`, `tpts` (PTS ditambahkan), `tnote` (pengingat login / batas / error).
