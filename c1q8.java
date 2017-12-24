/* zero matrix :
 * write an algorithm such that if an element of an NxM matrix is 0, set the entire row and column to 0's.
 * Strategy: to avoid repeatedly 0ing the same row/column, I will do a first-pass thru the
 * matrix, and keep track of the rows/columns that need to be zeroed, then 0 them in a second pass.
 */

import java.util.Random;

public class c1q8 {
	public static int[][] zeroMatrix(int[][] input) {
		boolean[] zeroRows = new boolean[input.length];
		for(int i = 0; i < zeroRows.length; i++) zeroRows[i] = false; //initialize array
		boolean[] zeroCols = new boolean[input[0].length];
		for(int j = 0; j < zeroCols.length; j++) zeroCols[j] = false; //initialize array
		
		for(int i = 0; i < input.length; i++) {
			for(int j = 0; j < input[0].length; j++) {
				if(input[i][j] == 0) {
					zeroRows[i] = true;
					zeroCols[j] =  true;
				}
			}
		}
		
		int[][] output = new int[input.length][input[0].length];
		//Deep-copy array
		for(int i = 0; i < input.length; i++) {
			for(int j =0; j < input[0].length; j++) {
				output[i][j] = input[i][j];
			}
		}


		for(int i = 0; i < zeroRows.length; i++) {
			if(zeroRows[i] == true) zeroRow(output,i);
		}

		for(int j = 0; j < zeroCols.length; j++) {
			if(zeroCols[j] == true) zeroCol(output,j);
		}

		return output;
	}

	public static void zeroRow(int[][] input, int row) {
		for(int j = 0; j < input[0].length; j++) {
			input[row][j] = 0;
		}
	}

	public static void zeroCol(int[][] input, int col) {
		for(int i = 0; i < input.length; i++) {
			input[i][col] = 0;
		}
	}

	public static void main(String [] args) {
		int[][] test1 = genNewMatrix(5,7);
		int[][] test2 = genNewMatrix(10,4);
		int[][] test3 = genNewMatrix(3,5);
		int[][] test4 = genNewMatrix(9,9);

		printMatrix(test1);
		printMatrix(zeroMatrix(test1));
		
		printMatrix(test2);
		printMatrix(zeroMatrix(test2));
		
		printMatrix(test3);
		printMatrix(zeroMatrix(test3));
		
		printMatrix(test4);
		printMatrix(zeroMatrix(test4));
			
	}

	public static void printMatrix(int[][] input) {
		for(int i = 0; i < input.length; i++) {
			for(int j = 0; j < input[0].length; j++) {
				System.out.print(input[i][j] + " ");
			}
			System.out.print("\n");
		}
		for(int i = 0; i < input[0].length; i++) System.out.print("__");
			System.out.print("\n");
	}

		
	public static int[][] genNewMatrix(int n, int m) { 		
		int [][]A=new int[n][m]; 	
		Random R=new Random(); 	
		
		
		int i,j; 	
		for( i=0; i < n ; i++ ) {
			for( j=0; j < m ; j++ ) {
				A[i][j]=R.nextInt(9); 	
			}	
		}	
		return A; 	
		
	}
	
}