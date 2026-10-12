// Dev-only: prints hex of JDK Blowfish/ECB/NoPadding(key, data). Args: keyAscii dataHex
import javax.crypto.Cipher;
import javax.crypto.spec.SecretKeySpec;

public class BlowfishCheck {
    public static void main(String[] a) throws Exception {
        byte[] k = a[0].getBytes();
        byte[] key = k;
        if (k.length < 16) { key = new byte[16]; System.arraycopy(k, 0, key, 0, k.length); }
        Cipher c = Cipher.getInstance("Blowfish/ECB/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "Blowfish"));
        byte[] d = new byte[a[1].length() / 2];
        for (int i = 0; i < d.length; i++) d[i] = (byte) Integer.parseInt(a[1].substring(2 * i, 2 * i + 2), 16);
        StringBuilder sb = new StringBuilder();
        for (byte b : c.doFinal(d)) sb.append(String.format("%02x", b));
        System.out.println(sb);
    }
}
