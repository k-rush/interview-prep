/*Write a function to check if a given string is a permutation of a palindrome. */

/* Ignore white space */

/* Thought process: 
	NAIVE APPROACH would be to find all of the permutations of the string 
	and check each one if it's a palindrome. LOL

	Probably count the characters, if they're all even counts 
	(except if string length is odd, then you can have one char with odd count), 
	you can make a palindrome.

	Tact Coa
	String length (- whitespace ) = 7
	t - 2
	a - 2
	c - 2
	o - 1

	Theory holds here....

	So algorithm would look like:

	Make string lowercase, remove whitespace.
	Count all the characters (Using an array of length 26, for each letter in alphabet)
	Increment array with string values.
	check to see if all characters are even, except one can be odd.

	Complexity?
		O(n) - a couple passes thru string (replaceAll, toLowerCase), one pass thru const size array.

*/



public class c1q4 {
	public static boolean isPalinPerm(String s) {
		int[] counter = new int[128];
		s = s.toLowerCase();
		s = s.replaceAll("\\s","");  //regex to replace all whitespace
		//System.out.println(s);

		//count the number of occurences of each character.
		for(int i = 0; i < s.length(); i++) {
			counter[(int)s.charAt(i)]++;
		}

		int numOfOddCounts = 0;
		for(int i = 0; i < 128; i++) {
			if(counter[i]%2==1) numOfOddCounts++;
			if(numOfOddCounts > 1) return false;
		}


		return true;
	}

	public static void main(String [] args) {
		System.out.println("Hez /ll  lo    : " + isPalinPerm("Hez /ll  lo    "));
		System.out.println("Taco cat: " + isPalinPerm("Taco cat"));
		System.out.println("RacEcAr: " + isPalinPerm("RacEcAr"));
		System.out.println("dddfsdfsadvddg: " + isPalinPerm("dddfsdfsadvddg"));
		
		
	}
}