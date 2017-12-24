import java.util.*;
public class c1q1 {
	/* This solution works, but is it optimal? The hash lookups are O(1), making this an O(n) algorithm (time-somplexity).
	*/
	static boolean isUnique (String s) {
		HashMap <Character,Boolean> seen = new HashMap<Character,Boolean>();

		char [] array = s.toCharArray();
		for(char c : array) {
			if(seen.containsKey(c)) return false;
			else seen.put(c,true);
		}
		return true;
	}

	public static void main(String [] args) {
			System.out.println(isUnique("abcd"));
			System.out.println(isUnique("aSJDNGFLKJDSNGS"));
			System.out.println(isUnique("abcdEFADSFFergfdsf"));
			System.out.println(isUnique("a"));
			System.out.println(isUnique("aaaaa"));
	}

}