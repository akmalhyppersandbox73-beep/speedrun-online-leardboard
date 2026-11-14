# Panduan Android: Aktifkan Global Leaderboard (database PostgreSQL gratis + Suga)

Semua langkah di bawah bisa dilakukan **hanya dari browser HP Android** (Chrome). Tidak perlu komputer.

Pesan *"no database configured"* berarti server belum menerima variabel **`DATABASE_URL`**. Panduan ini membuat database gratis, lalu memberikan alamatnya ke server di Suga.

> Tampilan Neon dan Suga bisa berubah dari waktu ke waktu. Nama tombol di bawah adalah yang paling umum; jika sedikit berbeda, cari tombol yang artinya sama.

---

## Gambaran singkat

1. Buat database PostgreSQL gratis di **Neon**.
2. Salin **connection string** (alamat database).
3. Tempel ke Suga sebagai **Environment Variable** bernama `DATABASE_URL`.
4. Deploy ulang, lalu cek `/health`.

Tabel database **dibuat otomatis** oleh server. Anda tidak perlu mengetik SQL.

---

## Langkah 1: Buat database gratis di Neon

1. Buka **https://neon.com** di Chrome, lalu **Sign up** (bisa dengan Google atau GitHub).
2. Buat project baru (**Create project** / **New project**):
   - **Name**: `speedrun`
   - **Region**: pilih yang terdekat dengan pemain, misalnya **Asia Pacific (Singapore)**.
   - Biarkan versi Postgres bawaan.
3. Tekan **Create**. Tunggu beberapa detik sampai dashboard project terbuka.

## Langkah 2: Salin connection string

1. Di dashboard project, tekan tombol **Connect**.
2. Pastikan database dan role bawaan terpilih (biasanya `neondb` dan `neondb_owner`).
3. Pilih tab/format **Connection string**. Tekan **Show password** agar password terlihat, bukan titik-titik.
4. Tekan ikon **Copy** (atau tekan lama teksnya, pilih semua, lalu salin).

Hasilnya kira-kira seperti ini (ini hanya contoh bentuk):

```
postgresql://neondb_owner:xxxxxxxx@ep-nama-acak-123456.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
```

Pastikan teksnya **diawali `postgresql://`** dan password **bukan titik-titik**.

> Jika Neon menampilkan perintah `psql 'postgresql://...'`, salin saja seluruhnya. Server otomatis mengambil bagian alamatnya.

> **Rahasiakan** alamat ini. Siapa pun yang punya dapat membaca dan mengubah database Anda. Jangan menempelnya di GitHub, grup, atau screenshot. Jika bocor: di Neon pilih **Reset password**, lalu perbarui `DATABASE_URL` di Suga.

## Langkah 3: Tempel ke Suga sebagai Environment Variable

1. Buka dashboard **Suga**, lalu buka project/service game Anda (yang menjalankan `server.js`).
2. Cari menu **Environment Variables** (kadang bernama *Variables*, *Secrets*, atau ada di **Project Settings**).
3. Tambahkan variabel baru:
   - **Name**: `DATABASE_URL` (huruf besar semua, tanpa spasi)
   - **Value**: tempel connection string dari Langkah 2 (tekan lama di kolom, pilih **Tempel/Paste**)
4. Opsional tapi disarankan, tambahkan satu lagi:
   - **Name**: `AUTH_SECRET`
   - **Value**: kata acak panjang, minimal 16 karakter (contoh: `kuda-biru-7391-sepatu-landak-0482`). **Jangan diubah lagi nanti**, karena semua pemain harus login ulang jika diubah.
5. Simpan, lalu **Deploy / Redeploy / Restart** service. Variabel baru baru terbaca setelah server dijalankan ulang.

Pengaturan build di Suga: install `npm install`, start `npm start`. Server memakai port dari hosting secara otomatis (`PORT`), jangan diisi manual.

**Alternatif:** jika Suga menyediakan Postgres bawaan, buat database di sana, lalu isi `DATABASE_URL` dengan connection string yang diberikan Suga. Sisanya sama persis. Jika alamatnya hanya bisa dipakai di jaringan internal Suga, server akan menebak SSL otomatis. Jika muncul masalah SSL, tambahkan `DATABASE_SSL` = `false`.

## Langkah 4: Periksa apakah database tersambung

Buka di Chrome (ganti dengan alamat game Anda):

```
https://ALAMAT-GAME-ANDA/health
```

Hasil yang **benar**:

```json
{"ok":true, ... ,"leaderboard":{"configured":true,"ready":true,"source":"DATABASE_URL","players":0,"ranked":0,...}}
```

Yang penting: **`"ready":true`**.

Di **Logs** Suga akan terlihat baris seperti ini:

```
database: connecting to ep-xxxx.neon.tech:5432/neondb as neondb_owner (from DATABASE_URL, SSL on ...)
database READY: PostgreSQL 16... | tables=app_secrets,tournament_results,users | players=0 ranked=0 | Global Leaderboard is ENABLED
```

Jika `ready` masih `false`, lihat bagian `hint` di `/health` atau log server. Isinya menyebut apa yang salah (lihat tabel masalah di bawah).

## Langkah 5: Coba di dalam game

1. Buka game, tekan **GLOBAL LEADERBOARD**. Pesan error hilang dan muncul **"No ranked players yet"**. Itu normal: daftar kosong sampai ada Tournament online yang selesai.
2. Tekan **Register**, buat username (3 sampai 16 karakter: huruf, angka, `_`) dan password minimal 6 karakter.
3. Main **Multiplayer → Tournament** online bersama minimal **1 pemain manusia lain**. Keduanya harus **login dengan akun masing-masing** sejak ronde pertama dan menyelesaikan **semua ronde**.
4. Setelah Tournament selesai, PTS masuk ke database secara permanen. Buka Global Leaderboard dan tekan **Refresh**: Top 100 dan **My Rank** muncul. PTS tidak hilang saat server restart atau deploy ulang.

Yang **tidak** menambah PTS: Singleplayer, Single Round, bermain sendirian melawan bot, atau keluar di tengah Tournament.

---

## Masalah umum dan solusinya

| Gejala (di `/health` → `hint`, atau Logs) | Penyebab | Solusi |
|---|---|---|
| `DATABASE_URL is not set` / pesan "no database configured" | Variabel belum ada, salah ketik nama, atau belum redeploy | Nama harus persis `DATABASE_URL`. Simpan, lalu **redeploy/restart**. |
| `still contains the example values` | Yang tertempel masih `USER:PASSWORD@HOST` | Salin connection string asli dari Neon. |
| `still contains the placeholder for the password` | Ada `[YOUR-PASSWORD]` (biasa di Supabase) | Ganti seluruh `[YOUR-PASSWORD]`, termasuk kurung siku, dengan password asli. |
| `not a valid PostgreSQL connection string` | Tertempel tidak lengkap / salah bentuk | Harus diawali `postgresql://` dan diakhiri nama database. Salin ulang. |
| `Wrong password (or username)` | Password salah atau sudah di-reset | Salin ulang connection string dengan **Show password**. |
| `database name ... does not exist` | Nama database di ujung alamat salah | Samakan dengan nama database di dashboard Neon (biasanya `neondb`). |
| `host ... cannot be found` | Salah ketik alamat host | Salin ulang. Untuk Supabase pakai **Session pooler**, bukan *Direct connection*. |
| `DATABASE_URL points to "localhost"` | Memakai alamat database lokal | Di hosting pakai alamat ONLINE dari Neon. |
| `requires SSL` | Database mewajibkan SSL | Tambah variabel `DATABASE_SSL` = `true`. |
| `does not accept SSL` | Database lokal/internal tanpa SSL | Tambah variabel `DATABASE_SSL` = `false`. |
| `too many connections` | Paket gratis punya sedikit koneksi | Tambah variabel `DATABASE_POOL_MAX` = `3`. |
| `did not answer in time` | Database gratis sedang "tidur" | Tunggu beberapa detik, server mencoba lagi otomatis (5 detik, lalu bertahap sampai 30 detik). |

Server **tidak berhenti** saat database bermasalah: game dan multiplayer tetap jalan, hanya leaderboard yang nonaktif, dan server terus mencoba menyambung sendiri. Jika ingin server menolak start tanpa database yang benar, tambahkan `REQUIRE_DATABASE` = `true`.

## Memperbarui file project dari Android

1. Ekstrak ZIP dengan aplikasi file manager (mis. Files by Google), atau gunakan **ZArchiver**.
2. Buka repository di **github.com** lewat Chrome, tekan **Add file → Upload files**, pilih semua file hasil ekstrak (termasuk `dbconfig.js` dan folder `scripts`/`test`), lalu **Commit changes**.
3. Suga akan membangun ulang otomatis jika deploy-on-push aktif. Jika tidak, tekan **Redeploy** manual.

## Lihat isi database (opsional)

Di Neon ada menu **SQL Editor**. Contoh perintah untuk melihat peringkat:

```sql
SELECT username, total_pts, tournaments FROM users ORDER BY total_pts DESC, reached_at ASC LIMIT 100;
```

Tabel yang dipakai: **`users`** (data pemain + `total_pts` permanen), **`tournament_results`** (riwayat setiap Tournament, mencegah PTS dobel), dan **`app_secrets`** (kunci token login otomatis).
