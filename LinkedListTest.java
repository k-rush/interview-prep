import java.util.Random;

public class LinkedListTest {
	public static void main(String[] args) {
		Random R = new Random();

		LinkedList myLinkedList = new LinkedList(R.nextInt(100));

		for(int i = 0; i < 10; i++) {
			myLinkedList.append(R.nextInt(100));
		}
		System.out.println(myLinkedList);
	}	
}