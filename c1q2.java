/* Given two strings, write a method to decide if one is a permutation of the other. */

/* Questions to ask interviewer: Does case matter?  What about spaces?
*/
import java.util.*;
public class c1q2 {
	public static boolean isPerm(String s1, String s2) {
		if(s1.length() != s2.length()) {
			return false; //return flase if strings are unequal length.
		}

		s1 = s1.toLowerCase(); //ignore case sensitivity
		s2 = s2.toLowerCase();

		/* We could sort the strings, and then do a simple string compare.
		 * runtime?
		 *	sorting: O(s1 * log(s1) + s2 * log(s2) )
		 *		Actually, we know s1 and s2 are equal length, therefor == O(s1 * log(s1))
		 *  strcmp: O(s1) 
		 *	
		 *	O(s1 + s1*log(s1)) == O(1*log(s1))
		 */

		char[] s1Array = s1.toCharArray();
		Arrays.sort(s1Array);
		char[] s2Array = s2.toCharArray();
		Arrays.sort(s2Array);
		String s1Sorted = new String(s1Array);
		String s2Sorted = new String(s2Array);
		//System.out.println("Sorted s1:" + s1Sorted);
		//System.out.println("Sorted s2:" + s2Sorted);

		return (s1Sorted.equals(s2Sorted));
	}

	public static void main(String [] args) {
		System.out.println("'aaa','aba': " + isPerm("aab", "aba"));
		System.out.println("'doNuts','stuNod': " + isPerm("doNuts", "stuNod"));
		System.out.println("'aABBba','bbaaab': " + isPerm("aABBba", "bbaaab"));
		System.out.println("'dasdasd','gsdfgds': " + isPerm("dasdasd", "gsdfgds"));
	}

}

