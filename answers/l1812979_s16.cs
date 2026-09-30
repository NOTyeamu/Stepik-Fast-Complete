using System;

public class MainClass
{
    public static void Main()
    {
        // put your c# code here
         string input = Console.ReadLine();
        if (input != null)
        {
            string lowerInput = input.ToLower();
            
            char[] charArray = lowerInput.ToCharArray();
            Array.Reverse(charArray);
            Console.WriteLine(new string(charArray));
        }
    }
}