/* Chapter 1 Question 6
 * String compression
 */

public class c1q6 {
	public static String compress(String s) {
		String compressed = ""; //optimization - use stringbuilder here, so you don't create new class every iteration!
		char current = s.charAt(0);
		int count = 0;

		for(char c : s.toCharArray()) {
			if(c != current) {
				if(count>1) compressed = compressed + Character.toString(current) + count;
				else compressed = compressed + Character.toString(current);current = c;
				count = 1;
			}
			else count++;
		}

		if(count>1) compressed = compressed + Character.toString(current) + count;
		else compressed = compressed + Character.toString(current);

		return compressed;
	}

	public static void main(String [] args) {
		System.out.println(compress("aabcccccaaa"));
	}
}